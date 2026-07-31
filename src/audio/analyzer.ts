import type { AudioBuffer } from './wav.ts';
import { decodeWav } from './wav.ts';

/**
 * Small, deliberately unsophisticated, deterministic physical analysis.
 * Two versions coexist: v2 adds a spectral measure without mutating v1 results.
 */
export const ANALYSIS_SCHEMA_VERSION = 1;

export interface AnalyzerDefinition {
  name: string;
  version: string;
  metrics: readonly string[];
  run: (audio: AudioBuffer) => Record<string, number>;
}

const round = (n: number, places = 6): number => {
  const f = 10 ** places;
  return Number.isFinite(n) ? Math.round(n * f) / f : 0;
};

function basicMetrics(audio: AudioBuffer): Record<string, number> {
  const { samples, sampleRate, channels } = audio;
  const frames = channels > 0 ? samples.length / channels : 0;
  let peak = 0, sumSquares = 0, crossings = 0;
  let previous = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i]! / 32768;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sumSquares += v * v;
    if (i % channels === 0) {
      if ((previous < 0 && v >= 0) || (previous > 0 && v <= 0)) crossings += 1;
      previous = v;
    }
  }
  const rms = samples.length > 0 ? Math.sqrt(sumSquares / samples.length) : 0;
  return {
    durationSeconds: round(sampleRate > 0 ? frames / sampleRate : 0),
    sampleRate, channels, frameCount: frames,
    peak: round(peak), rms: round(rms),
    zeroCrossingRate: round(frames > 0 ? crossings / frames : 0),
  };
}

/** Iterative radix-2 FFT; no recursion, no external dependency. */
function fftMagnitudes(input: Float64Array): Float64Array {
  const n = input.length;
  const re = Float64Array.from(input);
  const im = new Float64Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
        const ur = re[i + k]!, ui = im[i + k]!;
        const vr = re[i + k + len / 2]! * wr - im[i + k + len / 2]! * wi;
        const vi = re[i + k + len / 2]! * wi + im[i + k + len / 2]! * wr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
      }
    }
  }
  const mags = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) mags[i] = Math.hypot(re[i]!, im[i]!);
  return mags;
}

function spectralCentroid(audio: AudioBuffer): number {
  const N = 1024;
  const mono = new Float64Array(N);
  const { samples, channels } = audio;
  for (let f = 0; f < N; f++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) acc += samples[f * channels + c] ?? 0;
    // Hann window: deterministic and free of edge artefacts.
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * f) / (N - 1)));
    mono[f] = (acc / channels / 32768) * w;
  }
  const mags = fftMagnitudes(mono);
  let num = 0, den = 0;
  for (let k = 0; k < mags.length; k++) {
    const freq = (k * audio.sampleRate) / N;
    num += freq * mags[k]!; den += mags[k]!;
  }
  return den > 0 ? num / den : 0;
}

export const ANALYZER_V1: AnalyzerDefinition = {
  name: 'physical-analyzer',
  version: '1.0.0',
  metrics: ['durationSeconds', 'sampleRate', 'channels', 'frameCount', 'peak', 'rms', 'zeroCrossingRate'],
  run: (audio) => basicMetrics(audio),
};

export const ANALYZER_V2: AnalyzerDefinition = {
  name: 'physical-analyzer',
  version: '2.0.0',
  metrics: [...ANALYZER_V1.metrics, 'spectralCentroidHz', 'transientEstimate'],
  run: (audio) => {
    const base = basicMetrics(audio);
    const { samples, channels } = audio;
    let maxJump = 0;
    for (let i = channels; i < samples.length; i += channels) {
      maxJump = Math.max(maxJump, Math.abs(samples[i]! - samples[i - channels]!) / 32768);
    }
    return {
      ...base,
      spectralCentroidHz: round(spectralCentroid(audio), 3),
      transientEstimate: round(maxJump),
    };
  },
};

export function analyzeBytes(
  analyzer: AnalyzerDefinition, bytes: Uint8Array,
): Record<string, number> {
  return analyzer.run(decodeWav(bytes));
}
