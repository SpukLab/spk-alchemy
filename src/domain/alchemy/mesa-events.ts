import type { AudioBuffer } from '../../audio/wav.ts';
import {
  seededRandom, detectLocalEvents, mixAdd, localGainBoost, applyBoundaryFade,
} from '../../audio/operations.ts';

/**
 * Goteros + Acentos — mesa-exploration-v1@1.1.0's Eventos capability.
 *
 * Discrete local interventions in time, additive to Mesa's existing
 * continuous/global tools (Fragmentar/Acelerar/Microscopio/Excitar):
 *
 *  - Goteros introduces new local appearances, derived from the source
 *    Material, into the timeline.
 *  - Acentos emphasizes moments that already exist in the transformed
 *    timeline, without touching every one of them.
 *
 * Both are pure, deterministic, seeded functions over PCM16 frames, in the
 * same spirit as everything in operations.ts: identical inputs -> identical
 * outputs. Neither introduces a new canonical primitive, an Entity type, a
 * persistence authority, or Math.random. No AI, no external event source: a
 * droplet or accent is always derived from real signal content.
 */

export interface EventoParams {
  cantidad: number;   // Goteros: how many discrete droplets may appear, 0..100
  variacion: number;  // Goteros: temporal irregularity / event diversity, 0..100
  presencia: number;  // Acentos: strength of selected accents, 0..100
  seleccion: number;  // Acentos: how changeable the selected events are, 0..100
}

const WINDOW_MS = 12;

function candidateWindowFrames(sampleRate: number): number {
  return Math.max(4, Math.round((sampleRate * WINDOW_MS) / 1000));
}

function deterministicShuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// ---- Acentos ------------------------------------------------------------------

/**
 * Hard density ceiling: even at Presencia=100, at most this fraction of
 * detected candidates may be accented. "Not every event becomes accented" is
 * a rule, not a slider outcome -- contrast between accented and ordinary
 * moments must survive at every setting.
 */
export const ACENTOS_DENSITY_CEILING_FRACTION = 0.5;

/** Pure, testable: how many of the candidates get accented at this Presencia. */
export function acentosSelectionCount(presencia: number, candidateCount: number): number {
  if (candidateCount <= 0) return 0;
  const ceiling = Math.max(1, Math.min(candidateCount,
    Math.ceil(candidateCount * ACENTOS_DENSITY_CEILING_FRACTION)));
  return Math.max(0, Math.min(ceiling, Math.round((Math.max(0, Math.min(100, presencia)) / 100) * ceiling)));
}

function applyAcentos(
  samples: Int16Array, channels: number, sampleRate: number,
  presencia: number, seleccion: number, seed: number,
): Int16Array {
  if (presencia <= 0) return samples;
  const candidates = detectLocalEvents(samples, channels, candidateWindowFrames(sampleRate));
  const targetCount = acentosSelectionCount(presencia, candidates.length);
  if (targetCount === 0) return samples;

  // Selección: low = the strongest candidates (stable across runs at fixed
  // Presencia); high = a seeded shuffle across the whole candidate pool, so
  // *which* moments get accented becomes changeable, not just how strongly.
  const rng = seededRandom(seed);
  const pool = seleccion >= 50 ? deterministicShuffle(candidates, rng) : candidates;
  const chosen = pool.slice(0, targetCount);

  const fadeFrames = Math.max(1, Math.round((sampleRate * 4) / 1000));       // 4ms
  const lengthFrames = Math.max(fadeFrames * 2, candidateWindowFrames(sampleRate) * 2);
  const gainNumerator = 10 + Math.round((Math.max(0, Math.min(100, presencia)) / 100) * 6); // up to 1.6x

  let out = samples;
  for (const c of chosen) {
    out = localGainBoost(out, channels, c.frame, lengthFrames, gainNumerator, 10, fadeFrames);
  }
  return out;
}

// ---- Goteros ------------------------------------------------------------------

export const GOTEROS_MAX_DROPLETS = 24;

/** Pure, testable: how many droplets appear at this Cantidad. Monotonic non-decreasing. */
export function goterosDropletCount(cantidad: number): number {
  const c = Math.max(0, Math.min(100, cantidad));
  return Math.max(0, Math.min(GOTEROS_MAX_DROPLETS, Math.round((c / 100) * GOTEROS_MAX_DROPLETS)));
}

function applyGoteros(
  source: AudioBuffer, output: Int16Array, channels: number, sampleRate: number,
  cantidad: number, variacion: number, seed: number,
): Int16Array {
  const count = goterosDropletCount(cantidad);
  if (count === 0) return output;
  const outputFrames = channels > 0 ? output.length / channels : 0;
  const sourceFrames = source.channels > 0 ? source.samples.length / source.channels : 0;
  if (outputFrames === 0 || sourceFrames === 0 || source.channels !== channels) return output;

  const candidates = detectLocalEvents(source.samples, source.channels, candidateWindowFrames(sampleRate));
  const v = Math.max(0, Math.min(100, variacion));
  const dropletMs = 15 + (v / 100) * 45; // 15..60ms, internal only -- never surfaced to the artist
  const dropletFrames = Math.max(4, Math.min(
    Math.floor(sourceFrames / 4), Math.round((sampleRate * dropletMs) / 1000)));
  const fadeFrames = Math.max(1, Math.round((sampleRate * 3) / 1000)); // 3ms click-safe edges
  const rng = seededRandom(seed);
  const spacing = outputFrames / count;

  let out = output;
  for (let i = 0; i < count; i++) {
    // A real detected candidate when available, else a deterministic
    // seed-derived fallback position -- never Math.random, always
    // reproducible, and always source-content-dependent when candidates exist.
    const candidate = candidates.length > 0 ? candidates[i % candidates.length]! : null;
    const fallbackStart = Math.floor(((i + 0.5) / count) * Math.max(1, sourceFrames - dropletFrames));
    let regionStart = candidate ? candidate.frame : fallbackStart;
    regionStart = Math.max(0, Math.min(regionStart, Math.max(0, sourceFrames - dropletFrames)));

    let droplet = source.samples.slice(
      regionStart * source.channels, (regionStart + dropletFrames) * source.channels);
    if (droplet.length === 0) continue;
    droplet = applyBoundaryFade(droplet, channels, fadeFrames, fadeFrames);

    // Position in the OUTPUT timeline: an even grid, displaced by
    // seed-derived jitter scaled by Variación -- regular at low Variación,
    // less predictable (never random) at high Variación.
    const jitter = (rng() - 0.5) * (v / 100) * spacing * 0.6;
    const atFrame = Math.max(0, Math.min(outputFrames - 1, Math.round(i * spacing + spacing / 2 + jitter)));

    out = mixAdd(out, droplet, atFrame, channels, 8, 10); // fixed, moderate droplet gain (0.8x)
  }
  return out;
}

// ---- combined entry point ------------------------------------------------------

/**
 * Applies Acentos then Goteros, in that order: Acentos emphasizes moments
 * already present in the Mesa-transformed timeline; Goteros then introduces
 * new source-derived appearances into the result. Both derive their content
 * or their targets from real signal -- `source` for Goteros' droplet
 * content, `transformed` (the Mesa output so far) for Acentos' candidates.
 */
export function applyEventos(
  source: AudioBuffer, transformed: Int16Array, channels: number, sampleRate: number,
  params: EventoParams, seed: number,
): Int16Array {
  let out = applyAcentos(transformed, channels, sampleRate, params.presencia, params.seleccion, (seed + 1) >>> 0);
  out = applyGoteros(source, out, channels, sampleRate, params.cantidad, params.variacion, (seed + 2) >>> 0);
  return out;
}
