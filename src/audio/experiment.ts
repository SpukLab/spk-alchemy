import type { AudioBuffer } from './wav.ts';
import { decodeWav, encodeWav } from './wav.ts';

/**
 * Deterministic experiment operations.
 *
 * Given identical input bytes, implementation version, parameters and seed,
 * output bytes are bit-for-bit identical. Verified by exact hash comparison,
 * never by tolerance.
 */
export const IMPLEMENTATION_VERSION = '1.0.0';

export type OperationName = 'reverse' | 'trim' | 'gain';

export interface OperationParameters {
  /** trim: inclusive start frame and exclusive end frame. */
  startFrame?: number;
  endFrame?: number;
  /** gain: integer numerator/denominator, avoiding float drift. */
  gainNumerator?: number;
  gainDenominator?: number;
  seed?: number;
}

function reverse(audio: AudioBuffer): AudioBuffer {
  const { samples, channels } = audio;
  const frames = samples.length / channels;
  const out = new Int16Array(samples.length);
  for (let f = 0; f < frames; f++) {
    const src = (frames - 1 - f) * channels;
    for (let c = 0; c < channels; c++) out[f * channels + c] = samples[src + c]!;
  }
  return { ...audio, samples: out };
}

function trim(audio: AudioBuffer, params: OperationParameters): AudioBuffer {
  const { samples, channels } = audio;
  const frames = samples.length / channels;
  const start = Math.max(0, Math.min(frames, params.startFrame ?? 0));
  const end = Math.max(start, Math.min(frames, params.endFrame ?? frames));
  return { ...audio, samples: samples.slice(start * channels, end * channels) };
}

function gain(audio: AudioBuffer, params: OperationParameters): AudioBuffer {
  const num = params.gainNumerator ?? 1;
  const den = params.gainDenominator ?? 1;
  const out = new Int16Array(audio.samples.length);
  for (let i = 0; i < audio.samples.length; i++) {
    // Integer arithmetic with explicit truncation: no float rounding drift.
    const scaled = Math.trunc((audio.samples[i]! * num) / den);
    out[i] = Math.max(-32768, Math.min(32767, scaled));
  }
  return { ...audio, samples: out };
}

export function applyOperation(
  operation: OperationName, inputBytes: Uint8Array, params: OperationParameters = {},
): Uint8Array {
  const audio = decodeWav(inputBytes);
  let result: AudioBuffer;
  switch (operation) {
    case 'reverse': result = reverse(audio); break;
    case 'trim': result = trim(audio, params); break;
    case 'gain': result = gain(audio, params); break;
    default: throw new Error(`unknown operation: ${operation as string}`);
  }
  return encodeWav(result);
}
