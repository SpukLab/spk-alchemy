import type { Preview } from './service.ts';
import type { ResearchConfiguration, DerivedParameters } from './research-configuration.ts';

/**
 * Preview Set — RUNTIME ONLY.
 *
 * Not a canonical primitive, not an Entity, never persisted. It groups the
 * Previews produced by one execution of a ResearchConfiguration so they can be
 * compared and chosen between. Discarding one Preview does not affect its
 * siblings; retaining one creates exactly one Material Entity through the
 * existing Retain semantics.
 */
export interface PreviewVariation {
  index: number;
  seed: number;
  preview: Preview;
  derivedParameters: DerivedParameters;
}

export interface PreviewSet {
  readonly kind: 'preview-set';
  researchIntentId: string;
  sourceMaterialIds: readonly string[];
  configurationId: string;
  configurationVersion: string;
  implementationVersion: string;
  baseSeed: number;
  variations: PreviewVariation[];
  executionAgentId: string;
  createdAt: number;
}

/**
 * Temporary comparison group — RUNTIME ONLY.
 *
 * Holds Preview or Material references for one comparison session. It creates
 * no canonical Entity, no Relationship and no Knowledge. This is deliberately
 * not Family and not Canonical Grouping.
 */
export interface ComparisonEntry {
  ref: string;
  refKind: 'preview' | 'material';
  order: number;
  label?: string;
}

export class ComparisonGroup {
  readonly #entries: ComparisonEntry[] = [];
  readonly createdAt: number;
  constructor(clock: () => number = () => Date.now()) { this.createdAt = clock(); }

  add(ref: string, refKind: 'preview' | 'material', label?: string): this {
    this.#entries.push({ ref, refKind, order: this.#entries.length, label });
    return this;
  }
  remove(ref: string): this {
    const i = this.#entries.findIndex((e) => e.ref === ref);
    if (i >= 0) this.#entries.splice(i, 1);
    this.#entries.forEach((e, idx) => { e.order = idx; });
    return this;
  }
  entries(): readonly ComparisonEntry[] { return [...this.#entries]; }
  size(): number { return this.#entries.length; }
  clear(): void { this.#entries.length = 0; }
}

export function selectVariation(set: PreviewSet, index: number): PreviewVariation {
  const found = set.variations.find((v) => v.index === index);
  if (!found) throw new Error(`variation ${index} not present in preview set`);
  return found;
}

export function variationByPreviewRef(set: PreviewSet, stagingRef: string): PreviewVariation {
  const found = set.variations.find((v) => v.preview.stagingRef === stagingRef);
  if (!found) throw new Error(`preview ${stagingRef} not present in preview set`);
  return found;
}

export function summarize(set: PreviewSet, cfg: ResearchConfiguration): string {
  return `${cfg.id}@${cfg.version} base=${set.baseSeed} variations=${set.variations.length}`;
}
