/**
 * Deterministic canonical WAV representation.
 *
 * The writer emits exactly one 44-byte canonical RIFF/PCM16 header and nothing
 * else: no LIST, no fact, no encoder metadata. Identical samples therefore
 * always produce identical bytes, so bit-for-bit reproducibility is a property
 * of the format, not of a tolerance.
 */
export interface AudioBuffer {
  sampleRate: number;
  channels: number;
  /** Interleaved PCM16 frames, one entry per sample. */
  samples: Int16Array;
}

export const CANONICAL_HEADER_BYTES = 44;

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}
function readAscii(view: DataView, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
}

export function encodeWav(audio: AudioBuffer): Uint8Array {
  const dataBytes = audio.samples.length * 2;
  const bytes = new Uint8Array(CANONICAL_HEADER_BYTES + dataBytes);
  const view = new DataView(bytes.buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);                       // PCM fmt chunk size
  view.setUint16(20, 1, true);                        // format = PCM
  view.setUint16(22, audio.channels, true);
  view.setUint32(24, audio.sampleRate, true);
  view.setUint32(28, audio.sampleRate * audio.channels * 2, true); // byte rate
  view.setUint16(32, audio.channels * 2, true);       // block align
  view.setUint16(34, 16, true);                       // bits per sample
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < audio.samples.length; i++) {
    view.setInt16(CANONICAL_HEADER_BYTES + i * 2, audio.samples[i]!, true);
  }
  return bytes;
}

export function decodeWav(bytes: Uint8Array): AudioBuffer {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || readAscii(view, 0, 4) !== 'RIFF'
    || readAscii(view, 8, 4) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE stream');
  }
  let offset = 12;
  let sampleRate = 0, channels = 0, bitsPerSample = 0;
  let samples: Int16Array | null = null;
  while (offset + 8 <= bytes.length) {
    const id = readAscii(view, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      const count = Math.floor(size / 2);
      const out = new Int16Array(count);
      for (let i = 0; i < count; i++) out[i] = view.getInt16(body + i * 2, true);
      samples = out;
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }
  if (!samples || bitsPerSample !== 16) throw new Error('unsupported WAV: expected PCM16 data');
  return { sampleRate, channels, samples };
}

/** Deterministic synthetic material for corpus generation. */
export function synthesize(
  seed: number, sampleRate = 8000, channels = 1, frames = 4000,
): AudioBuffer {
  const samples = new Int16Array(frames * channels);
  let state = (seed * 2654435761) >>> 0;
  const baseFreq = 55 + (seed % 24) * 11;
  for (let f = 0; f < frames; f++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const noise = ((state >>> 16) / 65535 - 0.5) * 0.15;
    const tone = Math.sin((2 * Math.PI * baseFreq * f) / sampleRate);
    const env = Math.min(1, f / 200) * Math.max(0, 1 - f / frames);
    for (let c = 0; c < channels; c++) {
      const v = (tone * 0.6 + noise) * env * (c === 0 ? 1 : 0.8);
      samples[f * channels + c] = Math.max(-32768, Math.min(32767, Math.round(v * 30000)));
    }
  }
  return { sampleRate, channels, samples };
}
