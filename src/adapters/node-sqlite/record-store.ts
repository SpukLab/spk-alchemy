import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  RecordStore, StoredRecord, Mutation, IndexQuery, Page, AdjacencyQuery,
} from '../../persistence/record-store.ts';
import { MAX_BATCH_MUTATIONS } from '../../persistence/record-store.ts';
import type { SchemaDeclaration, IndexDeclaration } from '../../persistence/schema.ts';
import { indexesFor } from '../../persistence/schema.ts';
import type { KeyComponent, KeyTuple } from '../../persistence/keys.ts';
import { encodeKey, decodeKey, prefixUpperBound, compareBytes } from '../../persistence/keys.ts';
import { BatchTooLargeError, UniquenessError } from '../../core/errors.ts';

/**
 * SQLite RecordStore adapter.
 *
 * Uses a deliberately generic collection/index-entry representation rather than
 * per-type tables with native indexes. That costs some idiomatic SQL, and buys
 * exact semantic parity with IndexedDB: identical key ordering, identical prefix
 * and range behaviour, identical pagination. Index entries live entirely inside
 * this adapter and never surface in the portable contract.
 */
export class SqliteRecordStore implements RecordStore {
  readonly #db: DatabaseSync;
  readonly #schema: SchemaDeclaration;

  constructor(filePath: string, schema: SchemaDeclaration) {
    if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true });
    this.#db = new DatabaseSync(filePath);
    this.#schema = schema;
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA foreign_keys = ON');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS records (
        collection TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY (collection, id)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS index_entries (
        collection TEXT NOT NULL, index_name TEXT NOT NULL,
        key BLOB NOT NULL, record_id TEXT NOT NULL,
        PRIMARY KEY (collection, index_name, key, record_id)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `);
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
    return encodeKey(decl.fields.map((f) => this.#extract(record, f)));
  }

  #removeIndexEntries(collection: string, id: string): void {
    this.#db.prepare(
      'DELETE FROM index_entries WHERE collection = ? AND record_id = ?',
    ).run(collection, id);
  }

  #insertIndexEntries(collection: string, record: StoredRecord): void {
    for (const decl of indexesFor(this.#schema, collection)) {
      const key = this.#indexKey(decl, record);
      if (decl.unique) {
        const clash = this.#db.prepare(
          `SELECT record_id FROM index_entries
           WHERE collection = ? AND index_name = ? AND key = ? AND record_id <> ?`,
        ).get(collection, decl.name, key, record.id) as { record_id: string } | undefined;
        if (clash) {
          throw new UniquenessError(collection, decl.name,
            `key already held by ${clash.record_id}`);
        }
      }
      this.#db.prepare(
        `INSERT OR REPLACE INTO index_entries
         (collection, index_name, key, record_id) VALUES (?, ?, ?, ?)`,
      ).run(collection, decl.name, key, record.id);
    }
  }

  #row(collection: string, id: string): StoredRecord | null {
    const row = this.#db.prepare(
      'SELECT payload FROM records WHERE collection = ? AND id = ?',
    ).get(collection, id) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as StoredRecord) : null;
  }

  // ---- portable contract ---------------------------------------------------

  async get(collection: string, id: string): Promise<StoredRecord | null> {
    return this.#row(collection, id);
  }

  async getMany(collection: string, ids: readonly string[]): Promise<(StoredRecord | null)[]> {
    return ids.map((id) => this.#row(collection, id));
  }

  async commit(batch: readonly Mutation[]): Promise<void> {
    if (batch.length > MAX_BATCH_MUTATIONS) {
      throw new BatchTooLargeError(batch.length, MAX_BATCH_MUTATIONS);
    }
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      for (const m of batch) {
        if (m.op === 'put') {
          // Adapter-internal read to retire obsolete index entries. Bounded,
          // fully determined, and never a domain decision.
          this.#removeIndexEntries(m.collection, m.record.id);
          this.#db.prepare(
            `INSERT INTO records (collection, id, payload) VALUES (?, ?, ?)
             ON CONFLICT (collection, id) DO UPDATE SET payload = excluded.payload`,
          ).run(m.collection, m.record.id, JSON.stringify(m.record));
          this.#insertIndexEntries(m.collection, m.record);
        } else {
          this.#removeIndexEntries(m.collection, m.id);
          this.#db.prepare(
            'DELETE FROM records WHERE collection = ? AND id = ?',
          ).run(m.collection, m.id);
        }
      }
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }

  async lookup(query: IndexQuery): Promise<Page<StoredRecord>> {
    const decl = this.#schema.indexes.find(
      (i) => i.name === query.index && i.collection === query.collection);
    if (!decl) throw new Error(`unknown index ${query.collection}.${query.index}`);

    let lower: Uint8Array | null = null;
    let upper: Uint8Array | null = null;
    if (query.eq) { lower = encodeKey(query.eq); upper = prefixUpperBound(lower); }
    else if (query.prefix) { lower = encodeKey(query.prefix); upper = prefixUpperBound(lower); }
    else if (query.range) {
      if (query.range.gte) lower = encodeKey(query.range.gte);
      if (query.range.lt) upper = encodeKey(query.range.lt);
    }
    // Keyset pagination: strictly after the last observed ordering tuple.
    if (query.after) {
      const afterKey = encodeKey(query.after);
      const bump = new Uint8Array(afterKey.length + 1);
      bump.set(afterKey, 0);
      bump[afterKey.length] = 0x00;
      if (!lower || compareBytes(bump, lower) > 0) lower = bump;
    }

    const clauses = ['e.collection = ?', 'e.index_name = ?'];
    const params: unknown[] = [query.collection, decl.name];
    if (lower) { clauses.push('e.key >= ?'); params.push(lower); }
    if (upper) { clauses.push('e.key < ?'); params.push(upper); }
    params.push(query.limit);

    const rows = this.#db.prepare(
      `SELECT e.key AS key, r.payload AS payload
       FROM index_entries e
       JOIN records r ON r.collection = e.collection AND r.id = e.record_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY e.key ASC, e.record_id ASC
       LIMIT ?`,
    ).all(...(params as never[])) as { key: Uint8Array; payload: string }[];

    const items = rows.map((r) => JSON.parse(r.payload) as StoredRecord);
    const nextAfter: KeyTuple | null = rows.length === query.limit && rows.length > 0
      ? decodeKey(new Uint8Array(rows[rows.length - 1]!.key))
      : null;
    return { items, nextAfter };
  }

  #adjacency(index: string, q: AdjacencyQuery): Promise<Page<StoredRecord>> {
    const prefix: KeyComponent[] = q.type ? [q.nodeId, q.type] : [q.nodeId];
    return this.lookup({
      collection: 'relationships', index, prefix,
      after: q.after, limit: q.limit,
    });
  }
  adjacencyBySource(q: AdjacencyQuery): Promise<Page<StoredRecord>> {
    return this.#adjacency('rel_by_source', q);
  }
  adjacencyByTarget(q: AdjacencyQuery): Promise<Page<StoredRecord>> {
    return this.#adjacency('rel_by_target', q);
  }

  async schemaVersion(): Promise<number> {
    const row = this.#db.prepare('SELECT v FROM meta WHERE k = ?')
      .get('schemaVersion') as { v: string } | undefined;
    return row ? Number(row.v) : 0;
  }

  /** Migration-layer use only; not part of the portable domain path. */
  setSchemaVersion(version: number): void {
    this.#db.prepare(
      'INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v',
    ).run('schemaVersion', String(version));
  }

  async scan(collection: string, after: string | null, limit: number): Promise<Page<StoredRecord>> {
    const rows = this.#db.prepare(
      `SELECT id, payload FROM records
       WHERE collection = ? AND id > ? ORDER BY id ASC LIMIT ?`,
    ).all(collection, after ?? '', limit) as { id: string; payload: string }[];
    const items = rows.map((r) => JSON.parse(r.payload) as StoredRecord);
    return {
      items,
      nextAfter: rows.length === limit && rows.length > 0
        ? [rows[rows.length - 1]!.id] : null,
    };
  }

  async close(): Promise<void> { this.#db.close(); }
}
