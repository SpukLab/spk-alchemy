import type {
  RecordStore, StoredRecord, Mutation, IndexQuery, Page, AdjacencyQuery,
} from '../../persistence/record-store.ts';
import { MAX_BATCH_MUTATIONS } from '../../persistence/record-store.ts';
import type { SchemaDeclaration, IndexDeclaration } from '../../persistence/schema.ts';
import { indexesFor } from '../../persistence/schema.ts';
import type { KeyComponent, KeyTuple } from '../../persistence/keys.ts';
import { encodeKey, decodeKey, prefixUpperBound } from '../../persistence/keys.ts';
import { BatchTooLargeError, UniquenessError } from '../../core/errors.ts';

/**
 * IndexedDB RecordStore adapter.
 *
 * This is the second implementation ADR-009 was waiting for. It uses the SAME
 * canonical key encoding as the SQLite adapter, storing Uint8Array keys rather
 * than native JavaScript values, because IndexedDB's native mixed-type ordering
 * differs from SQLite's and the declared canonical order would otherwise
 * silently diverge.
 *
 * Transaction discipline: every mutation of a batch is queued synchronously
 * inside one readwrite transaction and only then awaited. An IndexedDB
 * transaction auto-commits when the event loop yields with no pending requests,
 * so awaiting anything mid-batch would close it. The portable contract's
 * "fully precomputed batch" rule is what makes this possible.
 */

interface IDBFactoryLike {
  open(name: string, version?: number): IDBOpenDBRequest;
  deleteDatabase(name: string): IDBOpenDBRequest;
}

const RECORD_STORE_SUFFIX = '';
const INDEX_STORE = '__index_entries';
const META_STORE = '__meta';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/** Index entry key: [collection, indexName, encodedKey, recordId] as one binary key. */
function indexEntryKey(collection: string, index: string, key: Uint8Array, id: string): Uint8Array {
  const head = encodeKey([collection, index]);
  const tail = encodeKey([id]);
  const out = new Uint8Array(head.length + key.length + tail.length + 1);
  out.set(head, 0);
  out.set(key, head.length);
  out[head.length + key.length] = 0x00; // separator between key body and record id
  out.set(tail, head.length + key.length + 1);
  return out;
}

function scopePrefix(collection: string, index: string): Uint8Array {
  return new Uint8Array(encodeKey([collection, index]));
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
}

export class IndexedDbRecordStore implements RecordStore {
  readonly #db: IDBDatabase;
  readonly #schema: SchemaDeclaration;

  private constructor(db: IDBDatabase, schema: SchemaDeclaration) {
    this.#db = db; this.#schema = schema;
  }

  static async open(
    databaseName: string, schema: SchemaDeclaration, factory?: IDBFactoryLike,
  ): Promise<IndexedDbRecordStore> {
    const idb = factory ?? (globalThis as unknown as { indexedDB: IDBFactoryLike }).indexedDB;
    if (!idb) throw new Error('IndexedDB is not available in this environment');
    const req = idb.open(databaseName, schema.version);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const collection of schema.collections) {
        if (!db.objectStoreNames.contains(collection + RECORD_STORE_SUFFIX)) {
          db.createObjectStore(collection + RECORD_STORE_SUFFIX, { keyPath: 'id' });
        }
      }
      if (!db.objectStoreNames.contains(INDEX_STORE)) db.createObjectStore(INDEX_STORE);
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
    };
    const db = await request(req);
    return new IndexedDbRecordStore(db, schema);
  }

  // ---- internals -----------------------------------------------------------

  #extract(record: StoredRecord, path: string): KeyComponent {
    let cur: unknown = record;
    for (const part of path.split('.')) {
      if (cur === null || cur === undefined || typeof cur !== 'object') return null;
      cur = (cur as Record<string, unknown>)[part];
    }
    if (cur === undefined || cur === null) return null;
    if (typeof cur === 'string' || typeof cur === 'number' || typeof cur === 'boolean') return cur;
    return String(cur);
  }

  #indexKey(decl: IndexDeclaration, record: StoredRecord): Uint8Array {
    return new Uint8Array(encodeKey(decl.fields.map((f) => this.#extract(record, f))));
  }

  async #entriesForRecord(collection: string, id: string): Promise<Uint8Array[]> {
    // Adapter-internal read: find this record's existing index entries so the
    // obsolete ones can be retired in the same transaction.
    const tx = this.#db.transaction(INDEX_STORE, 'readonly');
    const store = tx.objectStore(INDEX_STORE);
    const out: Uint8Array[] = [];
    for (const decl of indexesFor(this.#schema, collection)) {
      const prefix = scopePrefix(collection, decl.name);
      const upper = prefixUpperBound(Buffer.from(prefix));
      const range = upper
        ? IDBKeyRange.bound(prefix, new Uint8Array(upper), false, true)
        : IDBKeyRange.lowerBound(prefix);
      const keys = await request(store.getAllKeys(range) as IDBRequest<IDBValidKey[]>);
      const values = await request(
        store.getAll(range) as IDBRequest<{ recordId: string }[]>);
      keys.forEach((k, i) => {
        if (values[i]?.recordId === id) out.push(new Uint8Array(k as ArrayBuffer));
      });
    }
    return out;
  }

  async #uniquenessConflict(
    collection: string, decl: IndexDeclaration, key: Uint8Array, id: string,
  ): Promise<string | null> {
    const tx = this.#db.transaction(INDEX_STORE, 'readonly');
    const store = tx.objectStore(INDEX_STORE);
    const scoped = concatBytes(scopePrefix(collection, decl.name), key);
    const upper = prefixUpperBound(Buffer.from(scoped));
    const range = upper
      ? IDBKeyRange.bound(scoped, new Uint8Array(upper), false, true)
      : IDBKeyRange.lowerBound(scoped);
    const values = await request(store.getAll(range) as IDBRequest<{ recordId: string }[]>);
    const clash = values.find((v) => v.recordId !== id);
    return clash ? clash.recordId : null;
  }

  // ---- portable contract ---------------------------------------------------

  async get(collection: string, id: string): Promise<StoredRecord | null> {
    const tx = this.#db.transaction(collection, 'readonly');
    const result = await request(tx.objectStore(collection).get(id) as IDBRequest<StoredRecord>);
    return result ?? null;
  }

  async getMany(collection: string, ids: readonly string[]): Promise<(StoredRecord | null)[]> {
    const tx = this.#db.transaction(collection, 'readonly');
    const store = tx.objectStore(collection);
    const out: (StoredRecord | null)[] = [];
    for (const id of ids) {
      out.push((await request(store.get(id) as IDBRequest<StoredRecord>)) ?? null);
    }
    return out;
  }

  async commit(batch: readonly Mutation[]): Promise<void> {
    if (batch.length > MAX_BATCH_MUTATIONS) {
      throw new BatchTooLargeError(batch.length, MAX_BATCH_MUTATIONS);
    }
    if (batch.length === 0) return;

    // PRECOMPUTE everything before opening the transaction. Nothing below this
    // point may await, or IndexedDB would auto-commit mid-batch.
    const plan: {
      puts: { collection: string; record: StoredRecord }[];
      deletes: { collection: string; id: string }[];
      indexPuts: { key: Uint8Array; recordId: string; keyBytes: Uint8Array }[];
      indexDeletes: Uint8Array[];
    } = { puts: [], deletes: [], indexPuts: [], indexDeletes: [] };

    for (const m of batch) {
      const collection = m.collection;
      const id = m.op === 'put' ? m.record.id : m.id;
      for (const key of await this.#entriesForRecord(collection, id)) plan.indexDeletes.push(key);
      if (m.op === 'put') {
        for (const decl of indexesFor(this.#schema, collection)) {
          const key = this.#indexKey(decl, m.record);
          if (decl.unique) {
            const clash = await this.#uniquenessConflict(collection, decl, key, m.record.id);
            if (clash) {
              throw new UniquenessError(collection, decl.name, `key already held by ${clash}`);
            }
          }
          plan.indexPuts.push({
            key: indexEntryKey(collection, decl.name, key, m.record.id),
            recordId: m.record.id,
            keyBytes: key,
          });
        }
        plan.puts.push({ collection, record: m.record });
      } else {
        plan.deletes.push({ collection, id });
      }
    }

    const stores = [...new Set([
      ...plan.puts.map((p) => p.collection),
      ...plan.deletes.map((d) => d.collection),
      INDEX_STORE,
    ])];
    const tx = this.#db.transaction(stores, 'readwrite');
    const indexStore = tx.objectStore(INDEX_STORE);
    for (const key of plan.indexDeletes) indexStore.delete(key as unknown as IDBValidKey);
    for (const p of plan.puts) tx.objectStore(p.collection).put(p.record);
    for (const d of plan.deletes) tx.objectStore(d.collection).delete(d.id);
    for (const e of plan.indexPuts) {
      indexStore.put({ recordId: e.recordId, keyBytes: e.keyBytes }, e.key as unknown as IDBValidKey);
    }
    await transactionDone(tx);
  }

  async lookup(query: IndexQuery): Promise<Page<StoredRecord>> {
    const decl = this.#schema.indexes.find(
      (i) => i.name === query.index && i.collection === query.collection);
    if (!decl) throw new Error(`unknown index ${query.collection}.${query.index}`);

    const scope = scopePrefix(query.collection, decl.name);
    let lower: Uint8Array = scope;
    let upper: Uint8Array | null = (() => {
      const u = prefixUpperBound(Buffer.from(scope));
      return u ? new Uint8Array(u) : null;
    })();

    const scoped = (tuple: KeyTuple): Uint8Array =>
      concatBytes(scope, new Uint8Array(encodeKey(tuple)));

    if (query.eq || query.prefix) {
      const base = scoped((query.eq ?? query.prefix)!);
      lower = base;
      const u = prefixUpperBound(Buffer.from(base));
      upper = u ? new Uint8Array(u) : null;
    } else if (query.range) {
      if (query.range.gte) lower = scoped(query.range.gte);
      if (query.range.lt) upper = scoped(query.range.lt);
    }
    if (query.after) {
      // Keyset: strictly after the last observed ordering tuple.
      //
      // The stored entry key is `scoped(orderingKey) + 0x00 + recordId`, so a
      // bump of 0x00 would still be a prefix of the matching entry and include
      // it. 0x01 sorts above every separator, excluding the exact match while
      // keeping every greater ordering key. No ordering key is a strict prefix
      // of another, because each one ends with the record id component.
      const bump = concatBytes(scoped(query.after), new Uint8Array([0x01]));
      if (Buffer.compare(Buffer.from(bump), Buffer.from(lower)) > 0) lower = bump;
    }

    const range = upper
      ? IDBKeyRange.bound(lower, upper, false, true)
      : IDBKeyRange.lowerBound(lower);

    const tx = this.#db.transaction(INDEX_STORE, 'readonly');
    const store = tx.objectStore(INDEX_STORE);
    const values = await request(store.getAll(range, query.limit) as IDBRequest<
      { recordId: string; keyBytes: Uint8Array }[]>);

    const items: StoredRecord[] = [];
    const recordTx = this.#db.transaction(query.collection, 'readonly');
    const recordStore = recordTx.objectStore(query.collection);
    for (const v of values) {
      const rec = await request(recordStore.get(v.recordId) as IDBRequest<StoredRecord>);
      if (rec) items.push(rec);
    }

    // The ordering key is stored in the entry value rather than parsed back out
    // of the composite key: encoded string components legitimately contain 0x00
    // bytes, so no separator scan can recover it reliably.
    let nextAfter: KeyTuple | null = null;
    if (values.length === query.limit && values.length > 0) {
      const lastKey = values[values.length - 1]!.keyBytes;
      nextAfter = decodeKey(Buffer.from(
        lastKey instanceof Uint8Array ? lastKey : new Uint8Array(lastKey)));
    }
    return { items, nextAfter };
  }

  #adjacency(index: string, q: AdjacencyQuery): Promise<Page<StoredRecord>> {
    const prefix: KeyComponent[] = q.type ? [q.nodeId, q.type] : [q.nodeId];
    return this.lookup({
      collection: 'relationships', index, prefix, after: q.after, limit: q.limit });
  }
  adjacencyBySource(q: AdjacencyQuery): Promise<Page<StoredRecord>> {
    return this.#adjacency('rel_by_source', q);
  }
  adjacencyByTarget(q: AdjacencyQuery): Promise<Page<StoredRecord>> {
    return this.#adjacency('rel_by_target', q);
  }

  async schemaVersion(): Promise<number> {
    const tx = this.#db.transaction(META_STORE, 'readonly');
    const v = await request(tx.objectStore(META_STORE).get('schemaVersion') as IDBRequest<number>);
    return v ?? 0;
  }

  async setSchemaVersion(version: number): Promise<void> {
    const tx = this.#db.transaction(META_STORE, 'readwrite');
    tx.objectStore(META_STORE).put(version, 'schemaVersion');
    await transactionDone(tx);
  }

  async scan(collection: string, after: string | null, limit: number): Promise<Page<StoredRecord>> {
    const tx = this.#db.transaction(collection, 'readonly');
    const range = after === null ? undefined : IDBKeyRange.lowerBound(after, true);
    const items = await request(
      tx.objectStore(collection).getAll(range, limit) as IDBRequest<StoredRecord[]>);
    return {
      items,
      nextAfter: items.length === limit && items.length > 0
        ? [items[items.length - 1]!.id] : null,
    };
  }

  async close(): Promise<void> { this.#db.close(); }
}
