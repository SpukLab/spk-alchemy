import type {
  EpistemicStage,
  EpistemicStanding,
  InstitutionalStanding,
} from './primitives.ts';

export const LEGACY_EPISTEMIC_STAGES: readonly EpistemicStage[] = [
  'observation',
  'hypothesis',
  'validated',
  'canon',
  'deprecated',
];

export function isLegacyEpistemicStage(value: unknown): value is EpistemicStage {
  return typeof value === 'string'
    && (LEGACY_EPISTEMIC_STAGES as readonly string[]).includes(value);
}

/**
 * Loss-minimizing interpretation of ADR-002 scalar state.
 *
 * Legacy 'canon' proves institutional endorsement in the old model, but it does
 * NOT prove what its independent epistemic standing was. Preserve that gap as
 * unknown rather than inventing validated/durable history.
 */
export function standingsFromLegacy(stage: EpistemicStage): {
  epistemic: EpistemicStanding;
  institutional: InstitutionalStanding;
} {
  switch (stage) {
    case 'observation':
      return { epistemic: 'observation', institutional: 'unendorsed' };
    case 'hypothesis':
      return { epistemic: 'hypothesis', institutional: 'unendorsed' };
    case 'validated':
      return { epistemic: 'validated', institutional: 'unendorsed' };
    case 'deprecated':
      return { epistemic: 'deprecated', institutional: 'unendorsed' };
    case 'canon':
      return { epistemic: 'unknown', institutional: 'endorsed' };
  }
}

/**
 * Compatibility projection for ADR-002-era readers/indexes.
 *
 * This projection is intentionally lossy. New decisions must use the orthogonal
 * standings, never infer epistemic truth from the projected value.
 */
export function legacyStageProjection(
  epistemic: EpistemicStanding,
  institutional: InstitutionalStanding,
): EpistemicStage {
  if (institutional === 'endorsed') return 'canon';
  if (epistemic === 'deprecated') return 'deprecated';
  if (epistemic === 'observation') return 'observation';
  if (epistemic === 'hypothesis' || epistemic === 'unknown') return 'hypothesis';
  return 'validated';
}
