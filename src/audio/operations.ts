import type { AudioBuffer } from './wav.ts';

/**
 * Deterministic building blocks for exploration.
 *
 * Every function here is a pure transform over PCM16 frames using integer
 * arithmetic and an explicitly seeded PRNG. No Math.random, no floating-point
 * accumulation that could drift between runs: identical inputs always produce
 * identical outputs, so reproducibility is testable bit for bit.
 */

/** Mulberry32: small, fast, fully determined by its seed. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Fragment { startFrame: number; endFrame: number }

/** Split into `count` fragments of equal frame length; the last absorbs the remainder. */
export function fragmentEvenly(totalFrames: number, count: number): Fragment[] {
  const n = Math.max(1, Math.min(count, totalFrames));
  const size = Math.floor(totalFrames / n);
  const out: Fragment[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ startFrame: i * size, endFrame: i === n - 1 ? totalFrames : (i + 1) * size });
  }
  return out;
}

/** Fisher-Yates driven by the seeded PRNG: same seed, same permutation. */
export function shuffleWithSeed<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function sliceFragment(audio: AudioBuffer, f: Fragment): Int16Array {
  return audio.samples.slice(f.startFrame * audio.channels, f.endFrame * audio.channels);
}

export function reverseFrames(samples: Int16Array, channels: number): Int16Array {
  const frames = samples.length / channels;
  const out = new Int16Array(samples.length);
  for (let f = 0; f < frames; f++) {
    const src = (frames - 1 - f) * channels;
    for (let c = 0; c < channels; c++) out[f * channels + c] = samples[src + c]!;
  }
  return out;
}

/** Integer gain as a rational: no float rounding drift between runs. */
export function applyGain(samples: Int16Array, numerator: number, denominator: number): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const scaled = Math.trunc((samples[i]! * numerator) / denominator);
    out[i] = Math.max(-32768, Math.min(32767, scaled));
  }
  return out;
}

export function silence(frames: number, channels: number): Int16Array {
  return new Int16Array(Math.max(0, frames) * channels);
}

export function concatSamples(parts: readonly Int16Array[]): Int16Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Int16Array(total);
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}

/**
 * Deterministic linear micro-fade at a splice boundary, applied to one
 * fragment piece. Fade-in ramps 0 -> 1 across its opening frames; fade-out
 * ramps 1 -> 0 across its closing frames. Both windows are independently
 * capped at floor(totalFrames / 4), so fade-in and fade-out can never overlap
 * inside one piece and a very short fragment safely reduces toward zero fade
 * rather than being rejected. The same coefficient is applied to every
 * channel of a frame, so stereo imaging never shifts because of the fade.
 */
export function applyBoundaryFade(
  samples: Int16Array, channels: number, fadeInFrames: number, fadeOutFrames: number,
): Int16Array {
  const totalFrames = channels > 0 ? samples.length / channels : 0;
  const maxPerSide = Math.floor(totalFrames / 4);
  const fadeIn = Math.min(fadeInFrames, maxPerSide);
  const fadeOut = Math.min(fadeOutFrames, maxPerSide);
  if (fadeIn <= 0 && fadeOut <= 0) return samples;

  const out = Int16Array.from(samples);
  for (let f = 0; f < fadeIn; f++) {
    const gain = (f + 1) / fadeIn; // reaches exactly 1 at the last fade-in frame
    for (let c = 0; c < channels; c++) {
      const idx = f * channels + c;
      out[idx] = Math.round(samples[idx]! * gain);
    }
  }
  for (let f = 0; f < fadeOut; f++) {
    const frame = totalFrames - fadeOut + f;
    const gain = 1 - (f + 1) / fadeOut; // reaches exactly 0 at the last frame
    for (let c = 0; c < channels; c++) {
      const idx = frame * channels + c;
      out[idx] = Math.round(samples[idx]! * gain);
    }
  }
  return out;
}

// ---- Mesa deterministic operations (mesa-exploration-v1) -------------------
// Additive only: nothing above this line is modified, so fragment-exploration
// -v1@1.0.0/1.1.0/1.2.0 remain byte-identical. These are pure, frame-safe,
// integer-or-fixed-arithmetic transforms reused by Mesa's own render pipeline.

/**
 * Deterministic time scaling by nearest-neighbor frame resampling.
 * ratio > 1 expands (slower/longer), ratio < 1 compresses (faster/shorter).
 * Expressed as an integer ratio (numerator/denominator) so the same inputs
 * always produce the same frame count and the same selected source frames —
 * no floating-point drift between platforms.
 */
export function timeScaleFrames(
  samples: Int16Array, channels: number, numerator: number, denominator: number,
): Int16Array {
  const sourceFrames = channels > 0 ? samples.length / channels : 0;
  if (sourceFrames === 0 || numerator <= 0 || denominator <= 0) return new Int16Array(0);
  const outFrames = Math.max(1, Math.round((sourceFrames * numerator) / denominator));
  const out = new Int16Array(outFrames * channels);
  for (let f = 0; f < outFrames; f++) {
    // Nearest-neighbor source frame, computed with integer-safe rounding.
    const srcFrame = Math.min(sourceFrames - 1, Math.floor((f * sourceFrames) / outFrames));
    for (let c = 0; c < channels; c++) out[f * channels + c] = samples[srcFrame * channels + c]!;
  }
  return out;
}

/**
 * Deterministic bounded waveshaping (soft saturation) plus seeded
 * micro-amplitude perturbation. `intensity` in [0,100] controls wet/dry
 * blend; the dry floor (see MIN_DRY) guarantees some of the original signal
 * always survives, so high intensity reads as stressed/unstable rather than
 * pure noise or flat clipping.
 */
const MIN_DRY_NUMERATOR = 15; // at intensity=100, at least 15% dry signal remains
const DRY_DENOMINATOR = 100;

export function excite(
  samples: Int16Array, intensity: number, instability: number, seed: number,
): Int16Array {
  const clampedIntensity = Math.max(0, Math.min(100, intensity));
  const clampedInstability = Math.max(0, Math.min(100, instability));
  const wetNumerator = Math.min(DRY_DENOMINATOR - MIN_DRY_NUMERATOR, clampedIntensity);
  const dryNumerator = DRY_DENOMINATOR - wetNumerator;
  const rng = seededRandom(seed);
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i]! / 32768;
    // Soft saturation: cubic waveshaper, bounded to [-1, 1] by construction.
    const shaped = x - (x * x * x) / 3;
    // Deterministic micro-perturbation, scaled by instability.
    const jitter = clampedInstability > 0
      ? ((rng() - 0.5) * (clampedInstability / 100) * 0.08) : 0;
    const wet = Math.max(-1, Math.min(1, shaped + jitter));
    const blended = (samples[i]! * dryNumerator + Math.round(wet * 32768) * wetNumerator) / DRY_DENOMINATOR;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(blended)));
  }
  return out;
}

/**
 * Deterministic micro-region loop: extracts `regionFrames` starting at
 * `startFrame` and repeats it `repeatCount` times. This is Microscopio's
 * "persistence" behavior — dwelling on one discovered region rather than a
 * generic granular texture.
 */
export function loopRegion(
  samples: Int16Array, channels: number, startFrame: number, regionFrames: number, repeatCount: number,
): Int16Array {
  const totalFrames = channels > 0 ? samples.length / channels : 0;
  const start = Math.max(0, Math.min(startFrame, Math.max(0, totalFrames - 1)));
  const length = Math.max(1, Math.min(regionFrames, totalFrames - start));
  const region = samples.slice(start * channels, (start + length) * channels);
  const repeats = Math.max(1, repeatCount);
  const out = new Int16Array(region.length * repeats);
  for (let r = 0; r < repeats; r++) out.set(region, r * region.length);
  return out;
}
