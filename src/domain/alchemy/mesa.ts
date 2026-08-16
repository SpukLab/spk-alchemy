import type { AudioBuffer } from '../../audio/wav.ts';
import { decodeWav, encodeWav } from '../../audio/wav.ts';
import {
  seededRandom, fragmentEvenly, shuffleWithSeed, sliceFragment, reverseFrames,
  applyGain, silence, concatSamples, applyBoundaryFade, timeScaleFrames, excite, loopRegion,
} from '../../audio/operations.ts';
import {
  measurePreviewLevel, computePreviewGainCorrection, fadeFramesForSampleRate,
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

export interface MesaStrategy {
  id: string;
  territory: Territory;
  /** Multiplies MesaState intensities; each strategy emphasizes different tools. */
  weights: { fragmentar: number; acelerar: number; microscopio: number; excitar: number };
  /** Unexpected only. Medium strategies stay close to source by construction (no anchor needed). */
  anchor: PreservationAnchor;
}

/** Four Medium strategies: substantial but perceptually understandable transformation. */
export const MEDIUM_STRATEGIES: readonly MesaStrategy[] = [
  { id: 'medium-structure', territory: 'medium',
    weights: { fragmentar: 0.7, acelerar: 0.3, microscopio: 0.2, excitar: 0.2 }, anchor: null },
  { id: 'medium-fragment', territory: 'medium',
    weights: { fragmentar: 1.0, acelerar: 0.2, microscopio: 0.4, excitar: 0.3 }, anchor: null },
  { id: 'medium-temporal', territory: 'medium',
    weights: { fragmentar: 0.4, acelerar: 0.9, microscopio: 0.2, excitar: 0.2 }, anchor: null },
  { id: 'medium-texture', territory: 'medium',
    weights: { fragmentar: 0.3, acelerar: 0.2, microscopio: 0.8, excitar: 0.5 }, anchor: null },
];

/** Four Unexpected strategies: significant deviation, each with its own preservation anchor. */
export const UNEXPECTED_STRATEGIES: readonly MesaStrategy[] = [
  { id: 'unexpected-temporal-deviation', territory: 'unexpected',
    weights: { fragmentar: 0.5, acelerar: 1.3, microscopio: 0.3, excitar: 0.5 }, anchor: 'transient-peak' },
  { id: 'unexpected-microscopic-deviation', territory: 'unexpected',
    weights: { fragmentar: 0.3, acelerar: 0.3, microscopio: 1.4, excitar: 0.4 }, anchor: 'texture-window' },
  { id: 'unexpected-energetic-deviation', territory: 'unexpected',
    weights: { fragmentar: 0.8, acelerar: 0.4, microscopio: 0.3, excitar: 1.4 }, anchor: 'onset' },
  { id: 'unexpected-hybrid-deviation', territory: 'unexpected',
    weights: { fragmentar: 0.9, acelerar: 0.9, microscopio: 0.9, excitar: 0.9 }, anchor: 'fragment-identity' },
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
  for (const idx of order) {
    const fragment = fragments[idx];
    if (!fragment) continue;
    let piece = sliceFragment(source, fragment);
    if (reversed.has(idx)) piece = reverseFrames(piece, source.channels);
    // 2. Acelerar: deterministic time scaling. Movimiento varies the ratio
    // per fragment position when high, constant when low.
    const movementRng = seededRandom(operationSeed(strategySeed, 2 + idx));
    const variableRatio = params.timeRatioNum
      + (state.acelerar.movimiento > 50
          ? Math.round((movementRng() - 0.5) * ((state.acelerar.movimiento - 50) / 50) * 8) : 0);
    piece = timeScaleFrames(piece, source.channels,
      Math.max(4, variableRatio), params.timeRatioDen);
    // 3. Microscopio: replace the piece with a loop of a small internal region.
    if (state.microscopio.zoom + state.microscopio.persistencia > 20) {
      const pieceFrames = piece.length / source.channels;
      const regionFrames = Math.min(params.microscopeRegionFrames, Math.max(1, pieceFrames));
      const zoomRng = seededRandom(operationSeed(strategySeed, 3 + idx));
      const regionStart = Math.floor(zoomRng() * Math.max(1, pieceFrames - regionFrames));
      piece = loopRegion(piece, source.channels, regionStart, regionFrames, params.microscopeRepeats);
    }
    // 4. Excitar: bounded saturation + seeded micro-perturbation.
    if (params.exciteIntensity > 0 || params.exciteInstability > 0) {
      piece = excite(piece, params.exciteIntensity, params.exciteInstability, operationSeed(strategySeed, 4 + idx));
    }
    // Gain shaping consistent with the fragment-exploration lineage of tools.
    piece = applyGain(piece, Math.max(3, 10 - Math.floor(pieces.length / 2)), 10);
    pieces.push(piece);
    if (repeated.has(idx)) pieces.push(Int16Array.from(piece));
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

  // 7. Reuse the existing Preview-level gain-consistency correction unchanged.
  const correction = computePreviewGainCorrection(samples);
  if (correction !== 1) {
    const corrected = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      corrected[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i]! * correction)));
    }
    samples = corrected;
  }
  void measurePreviewLevel; // re-exported for callers/tests that want level data directly

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
