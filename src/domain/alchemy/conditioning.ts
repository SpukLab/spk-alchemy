import { decodeWav, encodeWav } from '../../audio/wav.ts';
import { applyGate, highPassFilter } from '../../audio/operations.ts';

/**
 * Source Conditioning V1 — input-conditioning-v1@1.0.0.
 *
 * A boundary between the canonical Material and exploration, shared by both
 * Rápida and Mesa: neither duplicates this DSP path. The canonical Material
 * in storage is never touched — conditioning operates only on the in-memory
 * exploration input buffer, and creates no Material of its own. If nothing is
 * ever Retained, no trace of conditioning exists anywhere.
 *
 * Deliberately independent of Mesa's own versioning: Mesa without
 * conditioning is byte-identical to before this feature existed (verified by
 * the bypass invariant test), so this is separate provenance, not a Mesa
 * version bump.
 */

export const CONDITIONING_CONFIGURATION_ID = 'input-conditioning-v1';
export const CONDITIONING_VERSION = '1.0.0';
export const CONDITIONING_SCHEMA_VERSION = 1;

export interface InputConditioningState {
  gate: { enabled: boolean; threshold: number };   // threshold: 0..100 ("Umbral")
  filter: { enabled: boolean; amount: number };     // amount: 0..100 ("Limpieza")
}

/** Both OFF by default — existing behavior must remain reproducible without an artist action. */
export const DEFAULT_CONDITIONING_STATE: InputConditioningState = {
  gate: { enabled: false, threshold: 30 },
  filter: { enabled: false, amount: 30 },
};

const clamp01to100 = (v: number): number => Math.max(0, Math.min(100, Math.round(v)));

export function validateConditioningState(state: InputConditioningState): InputConditioningState {
  return {
    gate: { enabled: !!state.gate.enabled, threshold: clamp01to100(state.gate.threshold) },
    filter: { enabled: !!state.filter.enabled, amount: clamp01to100(state.filter.amount) },
  };
}

export function serializeConditioningState(state: InputConditioningState): string {
  const s = validateConditioningState(state);
  return [s.gate.enabled ? 1 : 0, s.gate.threshold, s.filter.enabled ? 1 : 0, s.filter.amount].join(',');
}

/**
 * Umbral 0..100 -> gate RMS threshold 0.01..0.12, chosen from measurement on
 * a synthetic mixed fixture (quiet broadband noise + a loud foreground
 * event): across that range, quiet-region energy dropped roughly 85-90%
 * while active-region energy stayed at ~99% of its original level.
 */
function thresholdFromUmbral(umbral: number): number {
  return 0.01 + (umbral / 100) * 0.11;
}

/**
 * Limpieza 0..100 -> high-pass cutoff 0..200 Hz, chosen from measurement on a
 * synthetic rumble(40Hz)+useful-tone(800Hz) fixture: 200Hz selectively
 * suppressed the rumble component while leaving the useful band essentially
 * untouched, without the LPF component the brief said not to add blindly.
 * 0 maps to a literal no-op cutoff, so Limpieza=0 with the module enabled is
 * indistinguishable from disabled — a deliberately gentle floor.
 */
function cutoffFromLimpieza(limpieza: number): number {
  return (limpieza / 100) * 200;
}

export interface ResolvedConditioningParameters {
  gateThresholdRms: number | null;
  filterCutoffHz: number | null;
}

export function resolveConditioningParameters(state: InputConditioningState): ResolvedConditioningParameters {
  const s = validateConditioningState(state);
  return {
    gateThresholdRms: s.gate.enabled ? thresholdFromUmbral(s.gate.threshold) : null,
    filterCutoffHz: s.filter.enabled ? cutoffFromLimpieza(s.filter.amount) : null,
  };
}

/**
 * Applies conditioning to a canonical WAV buffer and returns a new canonical
 * WAV buffer — the exploration input, never the stored Material. Order is
 * Gate then Filter: gating first means the filter's per-channel state does
 * not have to settle across noise the gate already attenuated, giving a
 * cleaner high-pass transient at the very start of the buffer.
 *
 * BYPASS INVARIANT: when both modules are disabled, this returns the exact
 * input bytes untouched — not merely acoustically silent processing, the
 * identical Uint8Array reference. Reproducibility of the unconditioned path
 * depends on this being a literal no-op, not a null-effect transform.
 */
export function applyConditioning(inputBytes: Uint8Array, state: InputConditioningState): Uint8Array {
  const s = validateConditioningState(state);
  if (!s.gate.enabled && !s.filter.enabled) return inputBytes;

  const audio = decodeWav(inputBytes);
  const params = resolveConditioningParameters(s);
  let samples = audio.samples;
  if (params.gateThresholdRms !== null) {
    samples = applyGate(samples, audio.channels, audio.sampleRate, params.gateThresholdRms);
  }
  if (params.filterCutoffHz !== null && params.filterCutoffHz > 0) {
    samples = highPassFilter(samples, audio.channels, audio.sampleRate, params.filterCutoffHz);
  }
  return encodeWav({ ...audio, samples });
}
