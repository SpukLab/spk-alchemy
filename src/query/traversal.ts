import type { RecordStore } from '../persistence/record-store.ts';
import type { Relationship } from '../core/primitives.ts';

/**
 * Iterative BFS over indexed adjacency reads.
 *
 * No recursive SQL, no graph-engine traversal, no stored procedures. Memory is
 * bounded by page size and the visited set, never by corpus size.
 */
export interface TraversalOptions {
  relationshipType: string;
  direction: 'ancestors' | 'descendants';
  maxDepth?: number;
  pageSize?: number;
  maxNodes?: number;
}
export interface TraversalNode { id: string; depth: number }
export interface TraversalResult {
  nodes: TraversalNode[];
  edges: Relationship[];
  cyclesDetected: string[];
  truncated: boolean;
}

export async function traverse(
  store: RecordStore, startId: string, options: TraversalOptions,
): Promise<TraversalResult> {
  const pageSize = options.pageSize ?? 100;
  const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
  const maxNodes = options.maxNodes ?? 10_000;

  const visited = new Set<string>([startId]);
  const nodes: TraversalNode[] = [];
  const edges: Relationship[] = [];
  const cyclesDetected: string[] = [];
  let truncated = false;
  let frontier: string[] = [startId];
  let depth = 0;

  while (frontier.length > 0 && depth < maxDepth) {
    const next: string[] = [];
    for (const nodeId of frontier) {
      let after: readonly (string | number | boolean | null)[] | undefined;
      for (;;) {
        // "derived_from" points from derived -> original, so ancestors follow
        // outgoing edges and descendants follow incoming ones.
        const page = options.direction === 'ancestors'
          ? await store.adjacencyBySource({
              nodeId, type: options.relationshipType, after, limit: pageSize })
          : await store.adjacencyByTarget({
              nodeId, type: options.relationshipType, after, limit: pageSize });

        for (const raw of page.items) {
          const rel = raw as unknown as Relationship;
          edges.push(rel);
          const neighbour = options.direction === 'ancestors' ? rel.target : rel.source;
          if (visited.has(neighbour)) {
            // Revisiting a node already reached is a cycle in this projection.
            cyclesDetected.push(`${rel.source}->${rel.target}`);
            continue;
          }
          visited.add(neighbour);
          if (visited.size > maxNodes) { truncated = true; break; }
          next.push(neighbour);
        }
        if (truncated || page.nextAfter === null) break;
        after = page.nextAfter;
      }
      if (truncated) break;
    }
    depth += 1;
    for (const id of next) nodes.push({ id, depth });
    if (truncated) break;
    frontier = next;
  }

  // Canonical order: by depth, then createdAt/id of the first reaching edge.
  nodes.sort((a, b) => (a.depth - b.depth) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { nodes, edges, cyclesDetected, truncated };
}
