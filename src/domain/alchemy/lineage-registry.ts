import { LINEAGE_PALETTE, MULTI_ROOT_COLOR, resolveLineageRoot, paletteIndexForRoot } from './lineage.ts';
import type { AlchemyQueries } from '../../query/queries.ts';

/**
 * Lineage color registry — NONCANONICAL browser-local visual state.
 *
 * Explicit boundary: this is application UI state, not Material metadata and
 * not part of the Knowledge Graph. It never touches RecordStore, never adds an
 * Entity attribute, and losing it entirely costs nothing but the specific
 * colors previously shown. That is why it is injected as a plain
 * get/set store rather than reaching for canonical persistence.
 *
 * Replaces pure hash-modulo assignment, which permitted two unrelated roots to
 * collide on one palette slot while other slots sat unused — visually implying
 * ancestry that does not exist. The hash is still used, but only to pick the
 * starting search position, so assignment stays stable and spread out rather
 * than always filling slot 0 first.
 */

export interface LineageRegistryStore {
  read(): Promise<Record<string, number>>;
  write(assignments: Record<string, number>): Promise<void>;
}

/** In-memory store: the default for tests and any surface without persistence. */
export class MemoryLineageStore implements LineageRegistryStore {
  #data: Record<string, number> = {};
  async read(): Promise<Record<string, number>> { return { ...this.#data }; }
  async write(assignments: Record<string, number>): Promise<void> { this.#data = { ...assignments }; }
}

export class LineageColorRegistry {
  readonly #store: LineageRegistryStore;
  #assignments: Record<string, number> | null = null;
  readonly #paletteSize: number;

  constructor(store: LineageRegistryStore, paletteSize: number = LINEAGE_PALETTE.length) {
    this.#store = store;
    this.#paletteSize = paletteSize;
  }

  async #load(): Promise<Record<string, number>> {
    if (this.#assignments === null) this.#assignments = await this.#store.read();
    return this.#assignments;
  }

  /**
   * Returns the palette slot for a root, assigning one if this root is new.
   * An already-assigned root NEVER changes slot — adding a new root can only
   * consume a free slot, never reshuffle existing ones, so previously seen
   * colors stay stable across the whole life of the install.
   */
  async slotForRoot(rootId: string): Promise<number> {
    const assignments = await this.#load();
    const existing = assignments[rootId];
    if (existing !== undefined) return existing;

    const taken = new Set(Object.values(assignments));
    // Start the search at the hash position, so independent installs spread
    // across the palette instead of everyone filling slot 0 first.
    const start = paletteIndexForRoot(rootId, this.#paletteSize);
    let slot: number | null = null;
    for (let offset = 0; offset < this.#paletteSize; offset++) {
      const candidate = (start + offset) % this.#paletteSize;
      if (!taken.has(candidate)) { slot = candidate; break; }
    }
    // Palette exhaustion: every slot is assigned. Fall back to the hash
    // position deterministically -- a collision is now unavoidable, but it is
    // reproducible, and no existing root is disturbed to make room.
    if (slot === null) slot = start;

    assignments[rootId] = slot;
    await this.#store.write(assignments);
    return slot;
  }

  /** Resolves a Material's root, then its stable slot, then the color. */
  async colorForMaterial(materialId: string, queries: AlchemyQueries): Promise<string> {
    const { rootId, multiRoot } = await resolveLineageRoot(materialId, queries);
    if (multiRoot) return MULTI_ROOT_COLOR;
    return LINEAGE_PALETTE[await this.slotForRoot(rootId)] ?? MULTI_ROOT_COLOR;
  }

  /** Test/diagnostic access. Never used to drive rendering. */
  async assignments(): Promise<Record<string, number>> { return { ...(await this.#load()) }; }
}
