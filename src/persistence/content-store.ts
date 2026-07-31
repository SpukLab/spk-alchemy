/**
 * Portable ContentStore contract: audio bytes addressed by deterministic hash.
 * RecordStore and ContentStore cannot share one portable transaction, so
 * content is always written and verified BEFORE the record batch is committed.
 */
export interface ContentStat { hash: string; size: number }

export interface ContentStore {
  /** Idempotent by hash. Writing identical bytes twice is a no-op. */
  put(bytes: Uint8Array): Promise<ContentStat>;
  get(hash: string): Promise<Uint8Array | null>;
  has(hash: string): Promise<boolean>;
  stat(hash: string): Promise<ContentStat | null>;
  /** Maintenance only: enumerate stored hashes for garbage-collection audits. */
  list(): Promise<string[]>;
  close(): Promise<void>;
}
