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

// ---- Source conditioning (input-conditioning-v1) ---------------------------
// Additive only: nothing above this line is modified. These operate on the
// EXPLORATION INPUT BUFFER only, never on canonical Material bytes in
// storage — the caller decides what to condition, this module has no
// persistence awareness at all.

/**
 * Deterministic, click-safe noise gate.
 *
 * NOT a hard cut (`if sample < threshold: sample = 0`), which would produce
 * the same class of discontinuity clicks already solved for slice boundaries.
 * Works on short windows, smooths the gain envelope across windows with
 * separate attack/release rates (fast attack, slow release — the standard
 * shape that keeps transients intact while still closing gradually on
 * silence), then applies the resulting gain per-sample with linear
 * interpolation between window centers so no single sample jumps.
 *
 * `thresholdRms` is a normalized RMS in [0,1], compared against each
 * window's own RMS — interpretable relative to signal energy, never a raw
 * PCM amplitude cutoff. The floor (not zero) means quiet regions are
 * attenuated, never fully silenced: the gate reduces background noise, it
 * does not claim to remove noise buried inside active signal.
 */
export const GATE_WINDOW_MS = 5;
export const GATE_FLOOR = 0.12;
const GATE_ATTACK_COEFF = 0.6;  // fast: open quickly on real signal
const GATE_RELEASE_COEFF = 0.08; // slow: close gradually, no chatter

export function applyGate(
  samples: Int16Array, channels: number, sampleRate: number, thresholdRms: number,
): Int16Array {
  const totalFrames = channels > 0 ? samples.length / channels : 0;
  if (totalFrames === 0) return samples;
  const windowFrames = Math.max(1, Math.round((sampleRate * GATE_WINDOW_MS) / 1000));
  const windowCount = Math.max(1, Math.ceil(totalFrames / windowFrames));

  // Per-window RMS -> raw target gain (1 above threshold, floor below).
  const targets = new Float64Array(windowCount);
  for (let w = 0; w < windowCount; w++) {
    const start = w * windowFrames;
    const end = Math.min(totalFrames, start + windowFrames);
    let sumSquares = 0;
    let count = 0;
    for (let f = start; f < end; f++) {
      for (let c = 0; c < channels; c++) {
        const v = samples[f * channels + c]! / 32768;
        sumSquares += v * v;
        count += 1;
      }
    }
    const rms = count > 0 ? Math.sqrt(sumSquares / count) : 0;
    targets[w] = rms >= thresholdRms ? 1 : GATE_FLOOR;
  }

  // Smooth across windows: fast attack, slow release. Deterministic, no
  // platform-dependent behavior — plain IEEE754 arithmetic.
  const smoothed = new Float64Array(windowCount);
  smoothed[0] = targets[0]!;
  for (let w = 1; w < windowCount; w++) {
    const coeff = targets[w]! > smoothed[w - 1]! ? GATE_ATTACK_COEFF : GATE_RELEASE_COEFF;
    smoothed[w] = smoothed[w - 1]! + coeff * (targets[w]! - smoothed[w - 1]!);
  }

  // Apply per-sample gain, linearly interpolated between window centers so
  // no sample sees a stepped discontinuity.
  const out = new Int16Array(samples.length);
  const centerOf = (w: number): number => w * windowFrames + windowFrames / 2;
  for (let f = 0; f < totalFrames; f++) {
    const w = Math.min(windowCount - 1, Math.floor(f / windowFrames));
    const wNext = Math.min(windowCount - 1, w + 1);
    const c0 = centerOf(w);
    const c1 = centerOf(wNext);
    const t = c1 > c0 ? Math.max(0, Math.min(1, (f - c0) / (c1 - c0))) : 0;
    const gain = smoothed[w]! + t * (smoothed[wNext]! - smoothed[w]!);
    for (let c = 0; c < channels; c++) {
      const idx = f * channels + c;
      out[idx] = Math.max(-32768, Math.min(32767, Math.round(samples[idx]! * gain)));
    }
  }
  return out;
}

/**
 * Deterministic one-pole high-pass filter (RC-style), applied independently
 * per channel so stereo balance is never disturbed. Portable: pure
 * arithmetic, no platform-specific DSP, identical in Node and the browser.
 * `cutoffHz` below or equal to 0 is a no-op (returns the input unchanged),
 * which is what makes the conditioning bypass path byte-identical to
 * unconditioned audio.
 */
export function highPassFilter(
  samples: Int16Array, channels: number, sampleRate: number, cutoffHz: number,
): Int16Array {
  if (cutoffHz <= 0 || channels <= 0) return samples;
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const dt = 1 / sampleRate;
  const alpha = rc / (rc + dt);
  const totalFrames = samples.length / channels;
  const out = new Int16Array(samples.length);
  for (let c = 0; c < channels; c++) {
    let prevIn = samples[c] ?? 0;
    let prevOut = 0;
    for (let f = 0; f < totalFrames; f++) {
      const idx = f * channels + c;
      const x = samples[idx]!;
      const y = alpha * (prevOut + x - prevIn);
      out[idx] = Math.max(-32768, Math.min(32767, Math.round(y)));
      prevIn = x;
      prevOut = y;
    }
  }
  return out;
}

// ---- Mesa Eventos primitives (mesa-exploration-v1@1.1.0) --------------------
// Additive only: nothing above this line is modified. Reused by Goteros and
// Acentos (src/domain/alchemy/mesa-events.ts) — these are pure, frame-safe,
// deterministic building blocks, exactly like the Mesa primitives above.

export interface EventCandidate { frame: number; strength: number }

/**
 * Minimal deterministic local-event detector: per-window RMS energy compared
 * to the immediately preceding window. A candidate is a window whose energy
 * rises meaningfully -- a deliberately unsophisticated stand-in for onset
 * detection, not a full onset-detection library. Silence produces zero
 * candidates (energy never rises above the floor); very short input still
 * produces at least one window safely.
 *
 * Ranking is deterministic: strongest rise first, frame index as tie-break.
 */
export function detectLocalEvents(
  samples: Int16Array, channels: number, windowFrames: number,
): EventCandidate[] {
  const totalFrames = channels > 0 ? samples.length / channels : 0;
  if (totalFrames === 0 || windowFrames <= 0) return [];
  const windowCount = Math.max(1, Math.ceil(totalFrames / windowFrames));
  const energies = new Float64Array(windowCount);
  for (let w = 0; w < windowCount; w++) {
    const start = w * windowFrames;
    const end = Math.min(totalFrames, start + windowFrames);
    let sumSquares = 0;
    let count = 0;
    for (let f = start; f < end; f++) {
      for (let c = 0; c < channels; c++) {
        const v = samples[f * channels + c]! / 32768;
        sumSquares += v * v;
        count += 1;
      }
    }
    energies[w] = count > 0 ? Math.sqrt(sumSquares / count) : 0;
  }
  const candidates: EventCandidate[] = [];
  const RISE_THRESHOLD = 0.01;
  const FLOOR = 0.02;
  for (let w = 0; w < windowCount; w++) {
    const prev = w > 0 ? energies[w - 1]! : energies[w]!;
    const rise = energies[w]! - prev;
    if (rise > RISE_THRESHOLD && energies[w]! > FLOOR) {
      candidates.push({ frame: w * windowFrames, strength: rise });
    }
  }
  candidates.sort((a, b) => (b.strength - a.strength) || (a.frame - b.frame));
  return candidates;
}

/**
 * Mixes (adds, not replaces) `addition` into `base` starting at `atFrame`,
 * with an integer gain applied to the addition only. Truncates the addition
 * if it would run past the end of `base` -- never grows `base`. Peak safety
 * is not this function's job: callers rely on Mesa's own final peak ceiling.
 */
export function mixAdd(
  base: Int16Array, addition: Int16Array, atFrame: number, channels: number,
  gainNumerator: number, gainDenominator: number,
): Int16Array {
  const baseFrames = channels > 0 ? base.length / channels : 0;
  const addFrames = channels > 0 ? addition.length / channels : 0;
  const start = Math.max(0, Math.min(atFrame, baseFrames));
  const framesToMix = Math.max(0, Math.min(addFrames, baseFrames - start));
  if (framesToMix <= 0) return base;
  const out = Int16Array.from(base);
  for (let f = 0; f < framesToMix; f++) {
    for (let c = 0; c < channels; c++) {
      const baseIdx = (start + f) * channels + c;
      const addIdx = f * channels + c;
      const scaled = Math.trunc((addition[addIdx]! * gainNumerator) / gainDenominator);
      out[baseIdx] = Math.max(-32768, Math.min(32767, out[baseIdx]! + scaled));
    }
  }
  return out;
}

/**
 * Locally boosts (or cuts) gain over a short region, ramping in and out
 * across `fadeFrames` at each edge so the boost itself introduces no click.
 * This is Acentos' emphasis primitive: local, bounded, and reversible in
 * character (a gain multiplier, never a replacement of the underlying
 * signal), so the accented moment still sounds like itself, only more so.
 */
export function localGainBoost(
  samples: Int16Array, channels: number, atFrame: number, lengthFrames: number,
  gainNumerator: number, gainDenominator: number, fadeFrames: number,
): Int16Array {
  const totalFrames = channels > 0 ? samples.length / channels : 0;
  const start = Math.max(0, Math.min(atFrame, totalFrames));
  const length = Math.max(0, Math.min(lengthFrames, totalFrames - start));
  if (length <= 0) return samples;
  const out = Int16Array.from(samples);
  const fade = Math.max(0, Math.min(fadeFrames, Math.floor(length / 2)));
  const targetGain = gainNumerator / gainDenominator;
  for (let f = 0; f < length; f++) {
    let envelope = 1;
    if (fade > 0) {
      if (f < fade) envelope = (f + 1) / fade;
      else if (f >= length - fade) envelope = (length - f) / fade;
    }
    const extraGain = 1 + envelope * (targetGain - 1);
    for (let c = 0; c < channels; c++) {
      const idx = (start + f) * channels + c;
      out[idx] = Math.max(-32768, Math.min(32767, Math.round(samples[idx]! * extraGain)));
    }
  }
  return out;
}
