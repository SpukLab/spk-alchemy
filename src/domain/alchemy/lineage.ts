import { sha256 } from '../../core/sha256.ts';
import type { AlchemyQueries } from '../../query/queries.ts';

/**
 * Lineage color — a UI/domain recognition aid, not a canonical concept.
 *
 * It is derived, never persisted: no new canonical primitive, no new
 * persistence field, no ADR. The same root Material UUID always resolves to
 * the same palette entry, because the mapping is a pure function of that UUID
 * — reload, reopen, re-render and further descendants change nothing about
 * it, and it never depends on lifecycle state, Family membership or DNA Pack
 * publication.
 *
 * Color carries no meaning beyond "these Materials share an origin." It is
 * never lifecycle state, Knowledge, Family identity, or Agent identity.
 */

/**
 * Ten colors for a dark mobile UI, deliberately clear of the app's existing
 * semantic colors: --accent (#c9a227, the promoted tab / explore button /
 * status text) and --ok / --danger (#3b6b4a / #7a3b3b, the keep/reject
 * buttons). A lineage color must never be mistaken for "this is promoted" or
 * "this was accepted" — it means only "this shares an ancestor with that."
 */
export const LINEAGE_PALETTE: readonly string[] = [
  '#5b8ff0', // blue
  '#b07de8', // violet
  '#39c0c9', // cyan
  '#e8779b', // rose
  '#e8965a', // amber
  '#7fd694', // mint
  '#8f96e8', // indigo
  '#e2c15a', // sand
  '#5ecbb0', // teal
  '#d488d1', // orchid
];

/** Deterministic fallback for a Material with more than one root ancestor. */
export const MULTI_ROOT_COLOR = '#8b8b96'; // matches --dim: neutral, never confused with a lineage hue

/**
 * A root Material has no ancestor produced through Alchemy exploration:
 * a microphone capture, an imported WAV/AIFF/M4A, or any other directly
 * imported source. Every derived Material inherits its lineage color from
 * its root, however many generations deep.
 *
 * Multi-root fallback: the current exploration engine only ever derives from
 * one input Material at a time (see runResearchConfiguration), so every
 * derived Material has exactly one ancestry chain in practice. The general
 * case is handled anyway with the smallest reversible rule the brief asks
 * for: candidate roots are ordered by (depth descending, id ascending) and
 * the first is used, deterministically, with no extra queries beyond the
 * existing ancestors() traversal. If more than one root is present, the
 * neutral MULTI_ROOT_COLOR marker is used instead of guessing a blend.
 */
export async function resolveLineageRoot(
  materialId: string, queries: AlchemyQueries,
): Promise<{ rootId: string; multiRoot: boolean }> {
  const result = await queries.ancestors(materialId);
  if (result.nodes.length === 0) {
    return { rootId: materialId, multiRoot: false }; // this Material is its own root
  }
  const maxDepth = Math.max(...result.nodes.map((n) => n.depth));
  const deepest = result.nodes.filter((n) => n.depth === maxDepth).map((n) => n.id).sort();
  return { rootId: deepest[0]!, multiRoot: deepest.length > 1 };
}

/** Pure: stable palette index for a root UUID, independent of anything else. */
export function paletteIndexForRoot(rootId: string, paletteSize = LINEAGE_PALETTE.length): number {
  const digest = sha256(new TextEncoder().encode(rootId));
  const value = (digest[0]! << 24) | (digest[1]! << 16) | (digest[2]! << 8) | digest[3]!;
  return (value >>> 0) % paletteSize;
}

/** Pure convenience wrapper: root UUID -> hex color. */
export function lineageColorForRoot(rootId: string): string {
  return LINEAGE_PALETTE[paletteIndexForRoot(rootId)]!;
}

/** Resolves a Material's lineage color end to end: root lookup, then palette mapping. */
export async function lineageColorForMaterial(
  materialId: string, queries: AlchemyQueries,
): Promise<string> {
  const { rootId, multiRoot } = await resolveLineageRoot(materialId, queries);
  return multiRoot ? MULTI_ROOT_COLOR : lineageColorForRoot(rootId);
}
