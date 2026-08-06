import type { ContentStore, ContentStat } from '../../persistence/content-store.ts';
import { contentHash } from '../../core/ids.ts';

/**
 * IndexedDB ContentStore: audio bytes addressed by content hash.
 *
 * Blobs live in their own database so content and records stay independent,
 * preserving the ADR-009 rule that they never share a transaction. Content is
 * written and verified BEFORE the record batch, so an abandoned Retain leaves a
 * collectable orphan rather than a record pointing at absent bytes.
 *
 * OPFS is the natural later optimisation; it is deliberately not used yet.
 */
const STORE = 'content';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}
function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

interface IDBFactoryLike { open(name: string, version?: number): IDBOpenDBRequest }

export class IndexedDbContentStore implements ContentStore {
  readonly #db: IDBDatabase;
  private constructor(db: IDBDatabase) { this.#db = db; }

  static async open(databaseName: string, factory?: IDBFactoryLike): Promise<IndexedDbContentStore> {
    const idb = factory ?? (globalThis as unknown as { indexedDB: IDBFactoryLike }).indexedDB;
    if (!idb) throw new Error('IndexedDB is not available in this environment');
    const req = idb.open(databaseName, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    return new IndexedDbContentStore(await request(req));
  }

  async put(bytes: Uint8Array): Promise<ContentStat> {
    const hash = contentHash(bytes);
    const existing = await this.stat(hash);
    if (existing) return existing; // idempotent by construction
    const tx = this.#db.transaction(STORE, 'readwrite');
    // Store a copy: the caller's buffer may be a view into a larger one.
    tx.objectStore(STORE).put(bytes.slice(), hash);
    await transactionDone(tx);
    return { hash, size: bytes.byteLength };
  }

  async get(hash: string): Promise<Uint8Array | null> {
    const tx = this.#db.transaction(STORE, 'readonly');
    const v = await request(tx.objectStore(STORE).get(hash) as IDBRequest<Uint8Array | undefined>);
    return v ? new Uint8Array(v) : null;
  }

  async has(hash: string): Promise<boolean> { return (await this.stat(hash)) !== null; }

  async stat(hash: string): Promise<ContentStat | null> {
    const bytes = await this.get(hash);
    return bytes ? { hash, size: bytes.byteLength } : null;
  }

  async list(): Promise<string[]> {
    const tx = this.#db.transaction(STORE, 'readonly');
    const keys = await request(tx.objectStore(STORE).getAllKeys() as IDBRequest<IDBValidKey[]>);
    return keys.map(String).sort();
  }

  /** Maintenance only: garbage-collect orphaned blobs. Never on a domain path. */
  async remove(hash: string): Promise<void> {
    const tx = this.#db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(hash);
    await transactionDone(tx);
  }

  async close(): Promise<void> { this.#db.close(); }
}
