import { encodeWav } from '../../audio/wav.ts';
import type { AudioBuffer as CanonicalAudio } from '../../audio/wav.ts';

/**
 * Shared decode boundary.
 *
 * Both a microphone capture and an imported file end here: arbitrary encoded
 * bytes go in, canonical PCM16 WAV bytes come out. Neither CaptureFormatPolicy
 * nor ImportDecodePolicy duplicates this — they wrap it with source-specific
 * hints and error messages, but the actual decode happens exactly once, in one
 * place, for both paths.
 *
 * This lives in an adapter, not the canonical core: it depends on Web Audio.
 */
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
