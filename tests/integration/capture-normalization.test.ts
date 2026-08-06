import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeToCanonicalWav, detectRecorderCapability, PREFERRED_MIME_TYPES,
} from '../../src/adapters/web-audio/normalize.ts';
import { decodeWav } from '../../src/audio/wav.ts';
import { contentHash } from '../../src/core/ids.ts';

/** Stand-in for AudioContext.decodeAudioData with deterministic content. */
function fakeContext(channels: number, frames: number, rate = 44100) {
  return () => ({
    decodeAudioData: async () => ({
      numberOfChannels: channels, length: frames, sampleRate: rate,
      getChannelData: (c: number) => {
        const out = new Float32Array(frames);
        for (let i = 0; i < frames; i++) {
          out[i] = Math.sin((2 * Math.PI * (110 + c * 55) * i) / rate) * 0.8;
        }
        return out;
      },
    }),
    close: () => {},
  });
}

test('capture normalises to canonical PCM16 WAV regardless of source format', async () => {
  const bytes = await normalizeToCanonicalWav(new ArrayBuffer(8), fakeContext(2, 1000));
  const audio = decodeWav(bytes);
  assert.equal(audio.channels, 1, 'downmixed to mono by default');
  assert.equal(audio.sampleRate, 44100);
  assert.equal(audio.samples.length, 1000);
  assert.equal(bytes.byteLength, 44 + 1000 * 2, 'exactly one canonical 44-byte header');
});

test('normalisation is deterministic: same input, same bytes and hash', async () => {
  const a = await normalizeToCanonicalWav(new ArrayBuffer(8), fakeContext(2, 500));
  const b = await normalizeToCanonicalWav(new ArrayBuffer(8), fakeContext(2, 500));
  assert.deepEqual(Buffer.from(a), Buffer.from(b));
  assert.equal(contentHash(a), contentHash(b));
});

test('maxSeconds bounds a long capture deterministically', async () => {
  const bytes = await normalizeToCanonicalWav(
    new ArrayBuffer(8), fakeContext(1, 441000), { maxSeconds: 2 });
  assert.equal(decodeWav(bytes).samples.length, 88200, 'two seconds at 44.1 kHz');
});

test('recorder capability is detected by asking the browser, lossless first', () => {
  const losslessDevice = detectRecorderCapability({
    isTypeSupported: (t) => t === 'audio/wav' || t === 'audio/mp4' });
  assert.equal(losslessDevice.mimeType, 'audio/wav');
  assert.equal(losslessDevice.lossless, true);

  const alacDevice = detectRecorderCapability({
    isTypeSupported: (t) => t.includes('alac') || t === 'audio/mp4' });
  assert.equal(alacDevice.lossless, true, 'ALAC counts as lossless');

  const olderSafari = detectRecorderCapability({ isTypeSupported: (t) => t === 'audio/mp4' });
  assert.equal(olderSafari.mimeType, 'audio/mp4');
  assert.equal(olderSafari.lossless, false, 'AAC fallback is not lossless');

  const noRecorder = detectRecorderCapability(undefined);
  assert.equal(noRecorder.mimeType, null, 'absent MediaRecorder yields the browser default');
  assert.ok(PREFERRED_MIME_TYPES.indexOf('audio/wav') <
            PREFERRED_MIME_TYPES.indexOf('audio/mp4'), 'PCM preferred over AAC');
});
