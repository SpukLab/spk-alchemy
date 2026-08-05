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
