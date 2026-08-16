import type { AudioBuffer } from '../../audio/wav.ts';
import { decodeWav, encodeWav } from '../../audio/wav.ts';
import {
  seededRandom, fragmentEvenly, shuffleWithSeed, sliceFragment, reverseFrames,
  applyGain, silence, concatSamples, applyBoundaryFade, timeScaleFrames, excite, loopRegion,
} from '../../audio/operations.ts';
import {
  measurePreviewLevel, fadeFramesForSampleRate, PREVIEW_PEAK_CEILING,
  RESEARCH_CONFIGURATION_SCHEMA_VERSION,
} from './research-configuration.ts';
import type { ResearchConfiguration } from './research-configuration.ts';

/**
 * Mesa V1 — mesa-exploration-v1@1.0.0.
 *
 * A separate, additive ResearchConfiguration. fragment-exploration-v1 (all
 * three versions) is untouched: nothing here imports or calls its render
 * functions, and every new DSP primitive it needed was added to
 * operations.ts rather than modifying anything there.
 *
 * Mesa is domain/runtime configuration, not a canonical Entity: MesaState is
 * validated and translated into deterministic operation parameters entirely
 * in memory. Nothing here is persisted as a structural primitive; what
 * eventually reaches Retain is ordinary provenance on the Material Entity,
 * exactly like fragment-exploration-v1 already does.
 */

export const MESA_CONFIGURATION_ID = 'mesa-exploration-v1';
export const MESA_VERSION = '1.0.0';
export const MESA_SCHEMA_VERSION = RESEARCH_CONFIGURATION_SCHEMA_VERSION;

// ---- MesaState ---------------------------------------------------------------

export interface MesaState {
  fragmentar: { escala: number; desorden: number };
  acelerar: { tiempo: number; movimiento: number };
  microscopio: { zoom: number; persistencia: number };
  excitar: { energia: number; estabilidad: number };
}

/** Documented clamping rule: every control is clamped into [0, 100], never rejected. */
const clamp01to100 = (v: number): number => Math.max(0, Math.min(100, Math.round(v)));

export function validateMesaState(state: MesaState): MesaState {
  return {
    fragmentar: { escala: clamp01to100(state.fragmentar.escala), desorden: clamp01to100(state.fragmentar.desorden) },
    acelerar: { tiempo: clamp01to100(state.acelerar.tiempo), movimiento: clamp01to100(state.acelerar.movimiento) },
    microscopio: { zoom: clamp01to100(state.microscopio.zoom), persistencia: clamp01to100(state.microscopio.persistencia) },
    excitar: { energia: clamp01to100(state.excitar.energia), estabilidad: clamp01to100(state.excitar.estabilidad) },
  };
}

/**
 * Default: visible transformation without starting at maximum intensity,
 * chosen after generating the reference corpus described in the findings —
 * not a neutral 50/50/50/50 default, per the artist's stated preference for
 * moving away from the source.
 */
export const DEFAULT_MESA_STATE: MesaState = {
  fragmentar: { escala: 60, desorden: 60 },
  acelerar: { tiempo: 55, movimiento: 40 },
  microscopio: { zoom: 55, persistencia: 45 },
  excitar: { energia: 40, estabilidad: 55 },
};

/** Deterministic serialization used for provenance and for seed derivation. */
export function serializeMesaState(state: MesaState): string {
  const s = validateMesaState(state);
  return [
    s.fragmentar.escala, s.fragmentar.desorden, s.acelerar.tiempo, s.acelerar.movimiento,
    s.microscopio.zoom, s.microscopio.persistencia, s.excitar.energia, s.excitar.estabilidad,
  ].join(',');
}

// ---- territories and strategies ----------------------------------------------

export type Territory = 'medium' | 'unexpected';
export type PreservationAnchor = 'onset' | 'texture-window' | 'transient-peak' | 'fragment-identity' | null;

export type DominantTreatment =
  | 'balanced' | 'temporal-alternation' | 'microscopic-lock' | 'energetic-surge' | 'rotating-hybrid';

export interface MesaStrategy {
  id: string;
  territory: Territory;
  /** Multiplies MesaState intensities; each strategy emphasizes different tools. */
  weights: { fragmentar: number; acelerar: number; microscopio: number; excitar: number };
  /** Unexpected only. Medium strategies stay close to source by construction (no anchor needed). */
  anchor: PreservationAnchor;
  /**
   * Structural override applied per fragment, not just a weight multiplier.
   * 'balanced' (Medium) leaves the generic per-tool translation as the whole
   * story. Unexpected strategies each force ONE unmistakable, dominant
   * behavior so they read as genuinely different territories rather than
   * differently-seeded versions of the same generic transform.
   */
  dominantTreatment: DominantTreatment;
}

/** Four Medium strategies: substantial but perceptually understandable transformation. */
export const MEDIUM_STRATEGIES: readonly MesaStrategy[] = [
  { id: 'medium-structure', territory: 'medium',
    weights: { fragmentar: 0.8, acelerar: 0.35, microscopio: 0.25, excitar: 0.25 },
    anchor: null, dominantTreatment: 'balanced' },
  { id: 'medium-fragment', territory: 'medium',
    weights: { fragmentar: 1.0, acelerar: 0.25, microscopio: 0.5, excitar: 0.35 },
    anchor: null, dominantTreatment: 'balanced' },
  { id: 'medium-temporal', territory: 'medium',
    weights: { fragmentar: 0.45, acelerar: 1.0, microscopio: 0.25, excitar: 0.25 },
    anchor: null, dominantTreatment: 'balanced' },
  { id: 'medium-texture', territory: 'medium',
    weights: { fragmentar: 0.35, acelerar: 0.25, microscopio: 0.95, excitar: 0.6 },
    anchor: null, dominantTreatment: 'balanced' },
];

/** Four Unexpected strategies: significant deviation, each with its own preservation anchor. */
export const UNEXPECTED_STRATEGIES: readonly MesaStrategy[] = [
  { id: 'unexpected-temporal-deviation', territory: 'unexpected',
    weights: { fragmentar: 0.4, acelerar: 1.6, microscopio: 0.2, excitar: 0.4 },
    anchor: 'transient-peak', dominantTreatment: 'temporal-alternation' },
  { id: 'unexpected-microscopic-deviation', territory: 'unexpected',
    weights: { fragmentar: 0.25, acelerar: 0.25, microscopio: 1.8, excitar: 0.3 },
    anchor: 'texture-window', dominantTreatment: 'microscopic-lock' },
  { id: 'unexpected-energetic-deviation', territory: 'unexpected',
    weights: { fragmentar: 0.6, acelerar: 0.3, microscopio: 0.25, excitar: 1.9 },
    anchor: 'onset', dominantTreatment: 'energetic-surge' },
  { id: 'unexpected-hybrid-deviation', territory: 'unexpected',
    weights: { fragmentar: 0.9, acelerar: 0.9, microscopio: 0.9, excitar: 0.9 },
    anchor: 'fragment-identity', dominantTreatment: 'rotating-hybrid' },
];

export const MESA_STRATEGIES: readonly MesaStrategy[] = [...MEDIUM_STRATEGIES, ...UNEXPECTED_STRATEGIES];

// ---- deterministic seed derivation --------------------------------------------

/** baseSeed -> territorySeed -> strategySeed -> operation-specific seeds. Documented and tested. */
export function deriveStrategySeed(baseSeed: number, territory: Territory, strategyIndex: number): number {
  const territorySeed = (baseSeed + (territory === 'medium' ? 0 : 500_003)) >>> 0;
  return (territorySeed + strategyIndex * 104_729) >>> 0; // 104729: a prime, spreads strategies apart
}
function operationSeed(strategySeed: number, tag: number): number {
  return (strategySeed + tag * 40_009) >>> 0; // 40009: a prime, spreads operations apart
}

// ---- parameter translation -----------------------------------------------------

interface MesaOperationParams {
  fragmentCount: number;
  desordenStrength: number; // 0..1
  timeRatioNum: number; timeRatioDen: number;
  microscopeRegionFrames: number; microscopeRepeats: number;
  exciteIntensity: number; exciteInstability: number;
}

function translate(state: MesaState, strategy: MesaStrategy, totalFrames: number): MesaOperationParams {
  const w = strategy.weights;
  const escala = Math.min(100, state.fragmentar.escala * w.fragmentar);
  const desorden = Math.min(100, state.fragmentar.desorden * w.fragmentar);
  const tiempo = Math.min(100, state.acelerar.tiempo * w.acelerar);
  const zoom = Math.min(100, state.microscopio.zoom * w.microscopio);
  const persistencia = Math.min(100, state.microscopio.persistencia * w.microscopio);
  const energia = Math.min(100, state.excitar.energia * w.excitar);
  const estabilidad = Math.min(100, state.excitar.estabilidad * w.excitar);

  // Escala: GRANDE(0) -> few large fragments, PEQUEÑA(100) -> many small ones.
  const fragmentCount = Math.max(2, Math.min(24, Math.round(2 + (escala / 100) * 18)));
  // Tiempo: EXPANDIDO(0) -> ratio > 1 (slower), COMPRIMIDO(100) -> ratio < 1 (faster).
  // Expressed as an integer ratio over a fixed denominator for determinism.
  const timeRatioDen = 20;
  const timeRatioNum = Math.max(6, Math.min(34, Math.round(20 + ((50 - tiempo) / 50) * 14)));
  // Zoom: SUPERFICIE(0) -> larger regions, MICROSCÓPICO(100) -> tiny regions.
  const microscopeRegionFrames = Math.max(8, Math.round(totalFrames * (1 - zoom / 105)) >> 3 || 8);
  // Persistencia: FUGAZ(0) -> few repeats, INSISTENTE(100) -> many.
  const microscopeRepeats = Math.max(1, Math.min(8, Math.round(1 + (persistencia / 100) * 6)));

  return {
    fragmentCount, desordenStrength: desorden / 100,
    timeRatioNum, timeRatioDen,
    microscopeRegionFrames, microscopeRepeats,
    exciteIntensity: energia, exciteInstability: estabilidad,
  };
}

// ---- preservation anchor -------------------------------------------------------

/** Locates the anchor region in the SOURCE (pre-transformation) audio. */
function locateAnchor(source: AudioBuffer, anchor: PreservationAnchor): { start: number; length: number } | null {
  const totalFrames = source.channels > 0 ? source.samples.length / source.channels : 0;
  if (totalFrames === 0 || anchor === null) return null;
  const guardFrames = Math.max(1, Math.min(Math.floor(totalFrames / 8), 400));
  switch (anchor) {
    case 'onset':
      return { start: 0, length: guardFrames };
    case 'texture-window':
      return { start: Math.max(0, Math.floor(totalFrames / 2) - Math.floor(guardFrames / 2)), length: guardFrames };
    case 'transient-peak': {
      let peakFrame = 0, peakValue = -1;
      for (let f = 0; f < totalFrames; f++) {
        let frameMax = 0;
        for (let c = 0; c < source.channels; c++) {
          frameMax = Math.max(frameMax, Math.abs(source.samples[f * source.channels + c]!));
        }
        if (frameMax > peakValue) { peakValue = frameMax; peakFrame = f; }
      }
      const start = Math.max(0, peakFrame - Math.floor(guardFrames / 2));
      return { start: Math.min(start, Math.max(0, totalFrames - guardFrames)), length: guardFrames };
    }
    case 'fragment-identity':
      // A deterministic whole fragment: the second of an even 4-way split,
      // independent of the strategy's own fragment count, so it names a
      // stable, reproducible region regardless of Escala.
      return { start: Math.floor(totalFrames / 4), length: Math.max(1, Math.floor(totalFrames / 4)) };
    default:
      return null;
  }
}

/** Splices the anchor region from source verbatim into the transformed output, unmodified. */
function applyAnchor(
  source: AudioBuffer, output: Int16Array, channels: number, anchor: PreservationAnchor,
): Int16Array {
  const region = locateAnchor(source, anchor);
  if (!region) return output;
  const sourceSlice = source.samples.slice(
    region.start * channels, (region.start + region.length) * channels);
  if (sourceSlice.length === 0 || sourceSlice.length > output.length) return output;
  const out = Int16Array.from(output);
  out.set(sourceSlice, 0); // prepended: guarantees the anchor survives regardless of output length
  return out;
}

// ---- render ---------------------------------------------------------------------

function renderOneObservation(
  source: AudioBuffer, state: MesaState, strategy: MesaStrategy, strategySeed: number,
): AudioBuffer {
  const totalFrames = source.channels > 0 ? source.samples.length / source.channels : 0;
  const params = translate(state, strategy, totalFrames);

  // 1. Fragmentar: fragment + reorder (+ optional reversal/repeat via desorden).
  const fragments = fragmentEvenly(totalFrames, params.fragmentCount);
  const rng = seededRandom(operationSeed(strategySeed, 1));
  const order = shuffleWithSeed(fragments.map((_, i) => i), rng);
  const reversed = new Set(order.filter(() => rng() < params.desordenStrength * 0.5));
  const repeated = new Set(order.filter(() => rng() < params.desordenStrength * 0.25));

  const pieces: Int16Array[] = [];
  let position = 0;
  for (const idx of order) {
    const fragment = fragments[idx];
    if (!fragment) continue;
    let piece = sliceFragment(source, fragment);
    if (reversed.has(idx)) piece = reverseFrames(piece, source.channels);

    // 2. Acelerar.
    const movementRng = seededRandom(operationSeed(strategySeed, 2 + idx));
    if (strategy.dominantTreatment === 'temporal-alternation'
        || (strategy.dominantTreatment === 'rotating-hybrid' && position % 3 === 0)) {
      // Temporal deviation's signature: hard alternation, not gentle jitter.
      // Even positions compress hard, odd positions stretch hard -- the
      // "discontinuidad temporal" the artist asked for, audible on every cut.
      const strong = position % 2 === 0
        ? Math.max(3, Math.round(6 - (state.acelerar.movimiento / 100) * 3))   // compress hard
        : Math.round(34 + (state.acelerar.movimiento / 100) * 30);            // stretch hard
      piece = timeScaleFrames(piece, source.channels, strong, params.timeRatioDen);
    } else {
      const variableRatio = params.timeRatioNum
        + (state.acelerar.movimiento > 50
            ? Math.round((movementRng() - 0.5) * ((state.acelerar.movimiento - 50) / 50) * 8) : 0);
      piece = timeScaleFrames(piece, source.channels, Math.max(4, variableRatio), params.timeRatioDen);
    }

    // 3. Microscopio.
    const zoomRng = seededRandom(operationSeed(strategySeed, 3 + idx));
    if (strategy.dominantTreatment === 'microscopic-lock'
        || (strategy.dominantTreatment === 'rotating-hybrid' && position % 3 === 1)) {
      // Microscopic deviation's signature: force a small, insistently
      // repeated region regardless of the Zoom/Persistencia sliders, so the
      // granular/looping identity is never diluted by a mild MesaState.
      const pieceFrames = Math.max(1, piece.length / source.channels);
      const lockedRegion = Math.max(4, Math.min(Math.floor(pieceFrames / 6), 64));
      const lockedRepeats = 5 + Math.floor(zoomRng() * 4); // 5..8, always insistent
      const regionStart = Math.floor(zoomRng() * Math.max(1, pieceFrames - lockedRegion));
      piece = loopRegion(piece, source.channels, regionStart, lockedRegion, lockedRepeats);
    } else if (state.microscopio.zoom + state.microscopio.persistencia > 20) {
      const pieceFrames = piece.length / source.channels;
      const regionFrames = Math.min(params.microscopeRegionFrames, Math.max(1, pieceFrames));
      const regionStart = Math.floor(zoomRng() * Math.max(1, pieceFrames - regionFrames));
      piece = loopRegion(piece, source.channels, regionStart, regionFrames, params.microscopeRepeats);
    }

    // 4. Excitar.
    const exciteSeed = operationSeed(strategySeed, 4 + idx);
    if (strategy.dominantTreatment === 'energetic-surge'
        || (strategy.dominantTreatment === 'rotating-hybrid' && position % 3 === 2)) {
      // Energetic deviation's signature: push intensity/instability toward
      // their ceiling regardless of the sliders, so this territory always
      // reads as markedly more saturated and unstable than the others —
      // the dry floor inside excite() still guarantees it never fully
      // destroys the signal.
      const surgeIntensity = Math.max(75, params.exciteIntensity);
      const surgeInstability = Math.max(70, params.exciteInstability);
      piece = excite(piece, surgeIntensity, surgeInstability, exciteSeed);
    } else if (params.exciteIntensity > 0 || params.exciteInstability > 0) {
      piece = excite(piece, params.exciteIntensity, params.exciteInstability, exciteSeed);
    }

    // Gain shaping consistent with the fragment-exploration lineage of tools.
    // Energetic deviation stays intentionally loud throughout -- decaying it
    // like the other strategies would undercut the "louder and harsher"
    // signature the surge treatment exists to produce.
    if (strategy.dominantTreatment !== 'energetic-surge') {
      piece = applyGain(piece, Math.max(3, 10 - Math.floor(pieces.length / 2)), 10);
    }
    pieces.push(piece);
    if (repeated.has(idx)) pieces.push(Int16Array.from(piece));
    position += 1;
  }

  // 5. Reuse the proven boundary micro-fade infrastructure between pieces.
  const configuredFade = fadeFramesForSampleRate(source.sampleRate);
  for (let i = 0; i < pieces.length; i++) {
    const fadeIn = i > 0 ? configuredFade : 0;
    const fadeOut = i < pieces.length - 1 ? configuredFade : 0;
    if (fadeIn === 0 && fadeOut === 0) continue;
    pieces[i] = applyBoundaryFade(pieces[i]!, source.channels, fadeIn, fadeOut);
  }

  let samples = concatSamples(pieces);

  // 6. Preservation anchor (Unexpected only).
  samples = applyAnchor(source, samples, source.channels, strategy.anchor);

  // 7. Peak-only safety, deliberately NOT the reused RMS-targeting correction.
  //
  // fragment-exploration-v1's Preview-level correction pulls every variation
  // toward one shared RMS target -- exactly right when variations are meant
  // to sound comparably loud. Mesa's territories are the opposite: Energética
  // is SUPPOSED to read louder and harsher than Microscópica, that contrast
  // is the point. Reusing the RMS-pull step flattened it away -- measured on
  // the reference corpus, all eight observations converged to RMS 0.106-0.131
  // regardless of how differently they were actually shaped. Mesa applies
  // only a peak ceiling: reduce gain if (and only if) the transformation
  // pushed the signal toward clipping, otherwise leave each strategy's actual
  // energy character alone.
  const level = measurePreviewLevel(samples);
  if (level.peak > PREVIEW_PEAK_CEILING && level.peak > 0) {
    const safety = PREVIEW_PEAK_CEILING / level.peak;
    const corrected = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      corrected[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i]! * safety)));
    }
    samples = corrected;
  }

  return { ...source, samples };
}

export interface MesaObservation {
  strategyId: string;
  territory: Territory;
  anchor: PreservationAnchor;
  seed: number;
  bytes: Uint8Array;
}

/**
 * Runs the fixed 4 Medium + 4 Unexpected distribution. Deterministic and
 * order-stable: Medium strategies first (in MEDIUM_STRATEGIES order), then
 * Unexpected (in UNEXPECTED_STRATEGIES order).
 */
export function runMesaExploration(inputBytes: Uint8Array, state: MesaState, baseSeed: number): MesaObservation[] {
  const validated = validateMesaState(state);
  const source = decodeWav(inputBytes);
  const observations: MesaObservation[] = [];
  for (const strategy of MESA_STRATEGIES) {
    const index = strategy.territory === 'medium'
      ? MEDIUM_STRATEGIES.indexOf(strategy) : UNEXPECTED_STRATEGIES.indexOf(strategy);
    const strategySeed = deriveStrategySeed(baseSeed, strategy.territory, index);
    const rendered = renderOneObservation(source, validated, strategy, strategySeed);
    observations.push({
      strategyId: strategy.id, territory: strategy.territory, anchor: strategy.anchor,
      seed: strategySeed, bytes: encodeWav(rendered),
    });
  }
  return observations;
}

/** A minimal ResearchConfiguration-shaped wrapper, for provenance/CLI symmetry with fragment-exploration-v1. */
export const MESA_EXPLORATION_V1: Pick<ResearchConfiguration,
  'id' | 'version' | 'schemaVersion' | 'implementationVersion' | 'defaultVariationCount'> = {
  id: MESA_CONFIGURATION_ID, version: MESA_VERSION, schemaVersion: MESA_SCHEMA_VERSION,
  implementationVersion: MESA_VERSION, defaultVariationCount: 8,
};
