import type { KeyTuple } from './keys.ts';

/**
 * Portable RecordStore contract.
 *
 * Expresses semantic capabilities only. It exposes no SQL, tables, joins,
 * WHERE clauses, recursion, engine transaction objects or index-entry
 * representations. The domain submits semantic record mutations; each adapter
 * maintains its own internal index representation atomically.
 */

export interface StoredRecord { id: string; [k: string]: unknown }

export type Mutation =
  | { op: 'put'; collection: string; record: StoredRecord }
  | { op: 'delete'; collection: string; id: string };

/** One bounded atomic primitive. There is no open/interactive transaction. */
export const MAX_BATCH_MUTATIONS = 512;

export interface IndexQuery {
  collection: string;
  index: string;
  /** Exact match on the full declared key. */
  eq?: KeyTuple;
  /** Prefix match on the leading components of a compound key. */
  prefix?: KeyTuple;
  /** Bounded range on the leading components. */
  range?: { gte?: KeyTuple; lt?: KeyTuple };
  /**
   * Keyset pagination: the last canonical ordering tuple already observed.
   * Not an engine cursor handle. No snapshot isolation is promised.
   */
  after?: KeyTuple;
  limit: number;
}

export interface Page<T> {
  items: T[];
  /** Continuation tuple, or null when the page is the last one. */
  nextAfter: KeyTuple | null;
}

export interface AdjacencyQuery {
  nodeId: string;
  /** Optional relationship type filter, applied as a key prefix. */
  type?: string;
  after?: KeyTuple;
  limit: number;
}

export interface RecordStore {
  get(collection: string, id: string): Promise<StoredRecord | null>;
  getMany(collection: string, ids: readonly string[]): Promise<(StoredRecord | null)[]>;
  /** Commit a fully precomputed, bounded batch. No domain decisions inside. */
  commit(batch: readonly Mutation[]): Promise<void>;
  lookup(query: IndexQuery): Promise<Page<StoredRecord>>;
  adjacencyBySource(q: AdjacencyQuery): Promise<Page<StoredRecord>>;
  adjacencyByTarget(q: AdjacencyQuery): Promise<Page<StoredRecord>>;
  schemaVersion(): Promise<number>;
  /** Paginated full-collection scan. Maintenance/audit paths only. */
  scan(collection: string, after: string | null, limit: number): Promise<Page<StoredRecord>>;
  close(): Promise<void>;
}
