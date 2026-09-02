import type { AudioBuffer } from '../../audio/wav.ts';
import { decodeWav, encodeWav } from '../../audio/wav.ts';
import {
  seededRandom, detectLocalEvents, mixAdd, applyBoundaryFade, timeScaleFrames,
} from '../../audio/operations.ts';
import { measurePreviewLevel, PREVIEW_PEAK_CEILING } from './research-configuration.ts';
import { runMesaExploration } from './mesa.ts';
import type { MesaState, MesaObservation } from './mesa.ts';
import { DomainRuleError } from '../../core/errors.ts';

/**
 * mesa-relational-v1@1.0.0 — Source + Guest relational exploration.
 *
 * A layer ON TOP of Mesa V1.1, not a modification of it: every observation
 * is first rendered exactly as `runMesaExploration` already does (unchanged
 * import, unchanged call), and — only when a Guest is present — a relational
 * pass then mixes Guest-derived content into that already-complete buffer.
 * SOLO (no Guest) is therefore not merely equivalent to Mesa V1.1, it is
 * Mesa V1.1: the exact same bytes, because no relational code runs at all.
 *
 * This keeps Source strictly primary: the four continuous tools, Goteros,
 * Acentos, the preservation anchor, and Mesa's own peak-safety ceiling are
 * every one of them still driven entirely by Source and MesaState. Guest
 * can only ever ADD local content on top (via `mixAdd`, which never
 * lengthens the buffer it mixes into) — so output duration is, by
 * construction, always exactly the Source-derived Mesa duration. Guest
 * regions that would run past their own content are clamped, never wrapped
 * or extended, matching the deterministic-clamp convention Goteros already
 * established.
 *
 * No new canonical primitive: Source and Guest are ordinary Material
 * Entities: the caller (AlchemyService.runRelationalMesaExploration) passes
 * both into the existing multi-input Experiment/Retain machinery
 * (`inputMaterialIds`, `preview.sourceMaterialIds`), which already supports
 * more than one parent per Preview -- nothing here or in service.ts had to
 * change to make that true.
 */

export const RELATIONAL_CONFIGURATION_ID = 'mesa-relational-v1';
export const RELATIONAL_VERSION = '1.0.0';

export type RelationMode = 'solo' | 'inyectar' | 'acentuar-con' | 'contagiar' | 'cruzar';

export interface RelationalMesaContext {
  sourceMaterialId: string;
  guestMaterialId?: string;
  relationMode: RelationMode;
  guestInfluence: number; // 0..100
}

const clamp01to100 = (v: number): number => Math.max(0, Math.min(100, Math.round(v)));

const RELATION_MODES: readonly RelationMode[] = ['solo', 'inyectar', 'acentuar-con', 'contagiar', 'cruzar'];

/**
 * Validates the relational context. Guest absent forces `relationMode` to
 * 'solo' regardless of what was requested -- SOLO is the only mode that
 * makes sense without a Guest, and this is the guarantee backing the
 * backward-compatibility rule. Guest equal to Source is rejected outright:
 * not supported in V1, and not silently reinterpreted as SOLO. An
 * unrecognized relation mode string is rejected the same way -- it is never
 * silently coerced into a valid mode, which would hide a caller bug.
 */
export function validateRelationalContext(ctx: RelationalMesaContext): RelationalMesaContext {
  if (ctx.guestMaterialId && ctx.guestMaterialId === ctx.sourceMaterialId) {
    throw new DomainRuleError('Guest cannot equal Source in relational Mesa exploration');
  }
  const relationMode = ctx.guestMaterialId ? (ctx.relationMode || 'inyectar') : 'solo';
  if (!RELATION_MODES.includes(relationMode)) {
    throw new DomainRuleError(`unknown relation mode: ${String(relationMode)}`);
  }
  return {
    sourceMaterialId: ctx.sourceMaterialId,
    guestMaterialId: ctx.guestMaterialId,
    relationMode,
    guestInfluence: clamp01to100(ctx.guestInfluence),
  };
}

// ---- sample-rate / channel reconciliation --------------------------------------

/** Deterministic channel-count adaptation: duplicate (widen) or mean-downmix (narrow). */
function adaptChannelCount(samples: Int16Array, fromChannels: number, toChannels: number): Int16Array {
  if (fromChannels === toChannels || fromChannels <= 0 || toChannels <= 0) return samples;
  const frames = Math.floor(samples.length / fromChannels);
  const out = new Int16Array(frames * toChannels);
  for (let f = 0; f < frames; f++) {
    if (toChannels > fromChannels) {
      for (let c = 0; c < toChannels; c++) {
        out[f * toChannels + c] = samples[f * fromChannels + Math.min(c, fromChannels - 1)]!;
      }
    } else {
      for (let c = 0; c < toChannels; c++) {
        let sum = 0, count = 0;
        for (let s = c; s < fromChannels; s += toChannels) { sum += samples[f * fromChannels + s]!; count += 1; }
        out[f * toChannels + c] = Math.max(-32768, Math.min(32767, Math.round(sum / Math.max(1, count))));
      }
    }
  }
  return out;
}

/**
 * Reconciles Guest to Source's canonical shape before any relational DSP
 * touches it: resample (nearest-neighbor, via the existing `timeScaleFrames`
 * primitive -- real-world duration preserved, sample rate changed) then
 * adapt channel count to Source's topology. Deterministic, platform-free.
 */
export function adaptGuestToSource(guest: AudioBuffer, source: AudioBuffer): AudioBuffer {
  let samples = guest.samples;
  let channels = guest.channels;
  if (guest.sampleRate !== source.sampleRate && guest.sampleRate > 0 && channels > 0) {
    samples = timeScaleFrames(samples, channels, source.sampleRate, guest.sampleRate);
  }
  if (channels !== source.channels) {
    samples = adaptChannelCount(samples, channels, source.channels);
    channels = source.channels;
  }
  return { sampleRate: source.sampleRate, channels, samples };
}

// ---- shared Guest-content extraction --------------------------------------------

const WINDOW_MS = 12;
function windowFrames(sampleRate: number): number {
  return Math.max(4, Math.round((sampleRate * WINDOW_MS) / 1000));
}

/** A click-safe Guest fragment, clamped (never wrapped) within Guest's own content. */
function guestFragment(
  guest: AudioBuffer, regionStart: number, lengthFrames: number, channels: number, fadeFrames: number,
): Int16Array {
  const guestFrames = channels > 0 ? guest.samples.length / channels : 0;
  if (guestFrames === 0) return new Int16Array(0);
  const start = Math.max(0, Math.min(regionStart, Math.max(0, guestFrames - lengthFrames)));
  const len = Math.max(0, Math.min(lengthFrames, guestFrames - start));
  if (len <= 0) return new Int16Array(0);
  return applyBoundaryFade(
    guest.samples.slice(start * channels, (start + len) * channels), channels, fadeFrames, fadeFrames);
}

// ---- relation modes ---------------------------------------------------------------
// Each mode documents, in its own comment, which side drives EVENT TIMING and
// which side drives EVENT CONTENT -- the relational behavior the brief asks
// to keep explicit and legible.

/**
 * INYECTAR — timing: a deterministic grid across the Source observation,
 * jittered by seed (same style as Goteros). content: short Guest-derived
 * fragments, chosen from Guest's own detected events when available.
 */
function inyectar(
  sourceSamples: Int16Array, channels: number, sampleRate: number,
  guest: AudioBuffer, influence: number, seed: number,
): Int16Array {
  const outputFrames = channels > 0 ? sourceSamples.length / channels : 0;
  const guestFrames = channels > 0 ? guest.samples.length / channels : 0;
  if (outputFrames === 0 || guestFrames === 0) return sourceSamples;
  const count = Math.max(0, Math.min(20, Math.round((influence / 100) * 20)));
  if (count === 0) return sourceSamples;

  const candidates = detectLocalEvents(guest.samples, channels, windowFrames(sampleRate));
  const rng = seededRandom(seed);
  const fragMs = 15 + (influence / 100) * 40;
  const fragFrames = Math.max(4, Math.min(Math.floor(guestFrames / 4), Math.round((sampleRate * fragMs) / 1000)));
  const fadeFrames = Math.max(1, Math.round((sampleRate * 3) / 1000));
  const spacing = outputFrames / count;

  let out = sourceSamples;
  for (let i = 0; i < count; i++) {
    const candidate = candidates.length > 0 ? candidates[i % candidates.length]! : null;
    const fallback = Math.floor(((i + 0.5) / count) * Math.max(1, guestFrames - fragFrames));
    const frag = guestFragment(guest, candidate ? candidate.frame : fallback, fragFrames, channels, fadeFrames);
    if (frag.length === 0) continue;
    const jitter = (rng() - 0.5) * spacing * 0.5;
    const atFrame = Math.max(0, Math.min(outputFrames - 1, Math.round(i * spacing + spacing / 2 + jitter)));
    out = mixAdd(out, frag, atFrame, channels, 8, 10);
  }
  return out;
}

/**
 * ACENTUAR CON — timing: Source's OWN detected events (the strongest ones,
 * same density-ceiling discipline as ordinary Acentos). content: a
 * Guest-derived fragment mixed in at each selected Source moment, in place
 * of a plain gain boost. This is the explicit difference from ordinary
 * Acentos: the emphasis material itself comes from Guest.
 */
function acentuarCon(
  sourceSamples: Int16Array, channels: number, sampleRate: number,
  guest: AudioBuffer, influence: number, seed: number,
): Int16Array {
  const sourceCandidates = detectLocalEvents(sourceSamples, channels, windowFrames(sampleRate));
  const guestFrames = channels > 0 ? guest.samples.length / channels : 0;
  if (sourceCandidates.length === 0 || guestFrames === 0) return sourceSamples;

  const densityCeiling = Math.max(1, Math.min(sourceCandidates.length, Math.ceil(sourceCandidates.length * 0.5)));
  const count = Math.max(0, Math.min(densityCeiling, Math.round((influence / 100) * densityCeiling)));
  if (count === 0) return sourceSamples;
  const chosen = sourceCandidates.slice(0, count); // strongest Source moments; timing = Source

  const guestCandidates = detectLocalEvents(guest.samples, channels, windowFrames(sampleRate));
  const fragMs = 20 + (influence / 100) * 30;
  const fragFrames = Math.max(4, Math.min(Math.floor(guestFrames / 4), Math.round((sampleRate * fragMs) / 1000)));
  const fadeFrames = Math.max(1, Math.round((sampleRate * 4) / 1000));

  let out = sourceSamples;
  chosen.forEach((c, i) => {
    const guestCandidate = guestCandidates.length > 0 ? guestCandidates[i % guestCandidates.length]! : null;
    const fallback = Math.floor(((i + 0.5) / chosen.length) * Math.max(1, guestFrames - fragFrames));
    const frag = guestFragment(guest, guestCandidate ? guestCandidate.frame : fallback, fragFrames, channels, fadeFrames);
    if (frag.length === 0) return;
    const gainNumerator = 6 + Math.round((influence / 100) * 6); // 0.6x..1.2x -- content, not a boost
    out = mixAdd(out, frag, c.frame, channels, gainNumerator, 10);
  });
  return out;
}

/**
 * CONTAGIAR — timing: a dense deterministic grid across the Source
 * observation, jittered by seed. content: many SHORT, LOW-GAIN Guest
 * microfragments -- deliberately smaller and quieter than Inyectar's, so
 * the result reads as local texture "picking up" Guest's character rather
 * than discrete audible events. Source macrostructure survives by
 * construction: mixAdd only ever adds onto the untouched Source buffer, it
 * never replaces or truncates it.
 */
function contagiar(
  sourceSamples: Int16Array, channels: number, sampleRate: number,
  guest: AudioBuffer, influence: number, seed: number,
): Int16Array {
  const outputFrames = channels > 0 ? sourceSamples.length / channels : 0;
  const guestFrames = channels > 0 ? guest.samples.length / channels : 0;
  if (outputFrames === 0 || guestFrames === 0) return sourceSamples;
  const count = Math.max(0, Math.min(36, Math.round((influence / 100) * 36))); // denser than Inyectar
  if (count === 0) return sourceSamples;

  const rng = seededRandom(seed);
  const microMs = 6 + (influence / 100) * 10; // 6..16ms: shorter than Inyectar's fragments
  const microFrames = Math.max(3, Math.min(Math.floor(guestFrames / 4), Math.round((sampleRate * microMs) / 1000)));
  const fadeFrames = Math.max(1, Math.round((sampleRate * 2) / 1000));
  const spacing = outputFrames / count;
  const gainNumerator = 3 + Math.round((influence / 100) * 3); // 0.3x..0.6x: contamination, not replacement

  let out = sourceSamples;
  for (let i = 0; i < count; i++) {
    const regionStart = Math.floor(rng() * Math.max(1, guestFrames - microFrames));
    const frag = guestFragment(guest, regionStart, microFrames, channels, fadeFrames);
    if (frag.length === 0) continue;
    const jitter = (rng() - 0.5) * spacing * 0.7;
    const atFrame = Math.max(0, Math.min(outputFrames - 1, Math.round(i * spacing + spacing / 2 + jitter)));
    out = mixAdd(out, frag, atFrame, channels, gainNumerator, 10);
  }
  return out;
}

/**
 * CRUZAR — the hybrid mode: bounded contributions from all three other
 * modes, run in sequence over the same buffer. Influence is capped at 70
 * (even at Influence=100) before being split three ways, so Cruzar can
 * never become "maximum everything" -- it stays the strongest of the four
 * relational modes without degenerating into a raw A+B mix.
 */
function cruzar(
  sourceSamples: Int16Array, channels: number, sampleRate: number,
  guest: AudioBuffer, influence: number, seed: number,
): Int16Array {
  const bounded = Math.min(70, influence) * 0.6;
  let out = inyectar(sourceSamples, channels, sampleRate, guest, bounded, (seed + 11) >>> 0);
  out = acentuarCon(out, channels, sampleRate, guest, bounded, (seed + 12) >>> 0);
  out = contagiar(out, channels, sampleRate, guest, bounded, (seed + 13) >>> 0);
  return out;
}

function applyRelation(
  sourceSamples: Int16Array, channels: number, sampleRate: number,
  guest: AudioBuffer, mode: RelationMode, influence: number, seed: number,
): Int16Array {
  switch (mode) {
    case 'inyectar': return inyectar(sourceSamples, channels, sampleRate, guest, influence, seed);
    case 'acentuar-con': return acentuarCon(sourceSamples, channels, sampleRate, guest, influence, seed);
    case 'contagiar': return contagiar(sourceSamples, channels, sampleRate, guest, influence, seed);
    case 'cruzar': return cruzar(sourceSamples, channels, sampleRate, guest, influence, seed);
    case 'solo': default: return sourceSamples;
  }
}

// ---- top-level relational exploration ---------------------------------------------

export interface RelationalMesaObservation extends MesaObservation {
  relationMode: RelationMode;
  guestContributed: boolean;
}

/**
 * Runs the fixed 4 Medium + 4 Unexpected Mesa distribution exactly as
 * `runMesaExploration` does, then -- only when `guestBytes` is present and
 * the relation mode is not 'solo' -- layers a relational pass onto each of
 * the eight already-complete observations. When Guest is absent, this
 * function's output is `runMesaExploration`'s output, byte for byte: no
 * relational code executes at all.
 */
export function runRelationalMesaExploration(
  sourceBytes: Uint8Array, guestBytes: Uint8Array | null,
  mesaState: MesaState, baseSeed: number, ctx: RelationalMesaContext,
): RelationalMesaObservation[] {
  const validated = validateRelationalContext(ctx);
  const sourceObservations = runMesaExploration(sourceBytes, mesaState, baseSeed);

  if (!guestBytes || validated.relationMode === 'solo') {
    return sourceObservations.map((o) => ({ ...o, relationMode: 'solo' as const, guestContributed: false }));
  }

  const sourceAudio = decodeWav(sourceBytes);
  const guestAudio = decodeWav(guestBytes);
  const guestCanonical = adaptGuestToSource(guestAudio, sourceAudio);

  return sourceObservations.map((obs) => {
    const relationSeed = (obs.seed + 777_001) >>> 0;
    const rendered = decodeWav(obs.bytes);
    let samples = applyRelation(
      rendered.samples, rendered.channels, rendered.sampleRate,
      guestCanonical, validated.relationMode, validated.guestInfluence, relationSeed);

    // Same peak-only safety rule Mesa itself applies -- reduce gain only if
    // the relational contribution pushed the signal toward clipping.
    const level = measurePreviewLevel(samples);
    if (level.peak > PREVIEW_PEAK_CEILING && level.peak > 0) {
      const safety = PREVIEW_PEAK_CEILING / level.peak;
      const corrected = new Int16Array(samples.length);
      for (let i = 0; i < samples.length; i++) {
        corrected[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i]! * safety)));
      }
      samples = corrected;
    }

    return {
      ...obs, bytes: encodeWav({ ...rendered, samples }),
      relationMode: validated.relationMode, guestContributed: true,
    };
  });
}
