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

export function encodeWav(audio: AudioBuffer): Uint8Array {
  const dataBytes = audio.samples.length * 2;
  const buf = Buffer.alloc(CANONICAL_HEADER_BYTES + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);                       // PCM fmt chunk size
  buf.writeUInt16LE(1, 20);                        // format = PCM
  buf.writeUInt16LE(audio.channels, 22);
  buf.writeUInt32LE(audio.sampleRate, 24);
  buf.writeUInt32LE(audio.sampleRate * audio.channels * 2, 28); // byte rate
  buf.writeUInt16LE(audio.channels * 2, 32);       // block align
  buf.writeUInt16LE(16, 34);                       // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < audio.samples.length; i++) {
    buf.writeInt16LE(audio.samples[i]!, CANONICAL_HEADER_BYTES + i * 2);
  }
  return new Uint8Array(buf);
}

export function decodeWav(bytes: Uint8Array): AudioBuffer {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF'
    || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE stream');
  }
  let offset = 12;
  let sampleRate = 0, channels = 0, bitsPerSample = 0;
  let samples: Int16Array | null = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bitsPerSample = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      const count = Math.floor(size / 2);
      const out = new Int16Array(count);
      for (let i = 0; i < count; i++) out[i] = buf.readInt16LE(body + i * 2);
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
