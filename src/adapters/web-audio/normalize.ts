import { encodeWav } from '../../audio/wav.ts';
import type { AudioBuffer as CanonicalAudio } from '../../audio/wav.ts';

/**
 * Capture normalisation adapter.
 *
 * MediaRecorder output format varies by device and Safari version: PCM and ALAC
 * arrived in Safari 18.4, WebM/Opus in the same release, and older versions
 * record MP4/AAC only. Rather than branch on any of that downstream, everything
 * captured or imported is decoded once here and normalised to the canonical
 * PCM16 WAV representation BEFORE hashing, analysis, experimentation or
 * reproducibility comparison.
 *
 * This lives in an adapter, not the canonical core: it depends on Web Audio.
 */

/** Preference order for recording. Lossless first, then whatever the device offers. */
export const PREFERRED_MIME_TYPES: readonly string[] = [
  'audio/wav',                  // PCM
  'audio/mp4; codecs=alac',     // ALAC, lossless
  'audio/mp4;codecs=alac',
  'audio/webm; codecs=opus',
  'audio/webm',
  'audio/mp4',                  // AAC fallback
];

export interface RecorderCapability { mimeType: string | null; lossless: boolean }

/** Ask the browser rather than the user agent string. */
export function detectRecorderCapability(
  recorder: { isTypeSupported(t: string): boolean } | undefined =
    (globalThis as unknown as { MediaRecorder?: { isTypeSupported(t: string): boolean } }).MediaRecorder,
): RecorderCapability {
  if (!recorder || typeof recorder.isTypeSupported !== 'function') {
    return { mimeType: null, lossless: false };
  }
  for (const type of PREFERRED_MIME_TYPES) {
    if (recorder.isTypeSupported(type)) {
      return { mimeType: type, lossless: /wav|alac/i.test(type) };
    }
  }
  return { mimeType: null, lossless: false }; // browser default
}

export interface NormalizeOptions {
  sampleRate?: number;
  channels?: number;
  maxSeconds?: number;
}

type DecodedAudio = {
  numberOfChannels: number; length: number; sampleRate: number;
  getChannelData(channel: number): Float32Array;
};
type DecoderContext = {
  decodeAudioData(data: ArrayBuffer): Promise<DecodedAudio>;
  close?: () => void;
};

/**
 * Decode arbitrary captured/imported audio into canonical PCM16 WAV bytes.
 * Float samples are converted with explicit rounding and clamping so the same
 * decoded input always yields the same bytes.
 */
export async function normalizeToCanonicalWav(
  input: ArrayBuffer,
  createContext: (sampleRate: number) => DecoderContext,
  options: NormalizeOptions = {},
): Promise<Uint8Array> {
  const sampleRate = options.sampleRate ?? 44100;
  const targetChannels = Math.max(1, options.channels ?? 1);
  const ctx = createContext(sampleRate);
  const decoded = await ctx.decodeAudioData(input.slice(0));
  ctx.close?.();

  const maxFrames = options.maxSeconds
    ? Math.min(decoded.length, Math.floor(options.maxSeconds * decoded.sampleRate))
    : decoded.length;

  const sourceChannels = decoded.numberOfChannels;
  const channelData: Float32Array[] = [];
  for (let c = 0; c < sourceChannels; c++) channelData.push(decoded.getChannelData(c));

  const samples = new Int16Array(maxFrames * targetChannels);
  for (let f = 0; f < maxFrames; f++) {
    for (let c = 0; c < targetChannels; c++) {
      let value: number;
      if (targetChannels === 1 && sourceChannels > 1) {
        // Deterministic downmix: mean of all source channels.
        let sum = 0;
        for (let s = 0; s < sourceChannels; s++) sum += channelData[s]![f] ?? 0;
        value = sum / sourceChannels;
      } else {
        value = channelData[Math.min(c, sourceChannels - 1)]![f] ?? 0;
      }
      const clamped = Math.max(-1, Math.min(1, value));
      samples[f * targetChannels + c] =
        Math.max(-32768, Math.min(32767, Math.round(clamped * 32767)));
    }
  }

  const canonical: CanonicalAudio = {
    sampleRate: decoded.sampleRate, channels: targetChannels, samples,
  };
  return encodeWav(canonical);
}
