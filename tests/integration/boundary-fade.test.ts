import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FRAGMENT_EXPLORATION_V1, FRAGMENT_EXPLORATION_V1_1, FRAGMENT_EXPLORATION_V1_2,
  DEFAULT_FRAGMENT_EXPLORATION, configurationById,
  fadeFramesForSampleRate, PREVIEW_BOUNDARY_FADE_MS,
} from '../../src/domain/alchemy/research-configuration.ts';
import { applyBoundaryFade } from '../../src/audio/operations.ts';
import { synthesize, encodeWav, decodeWav } from '../../src/audio/wav.ts';
import { contentHash } from '../../src/core/ids.ts';

/**
 * Artist feedback (kept separate from measured evidence, in
 * docs/IMPLEMENTATION_FINDINGS.md): "Exploration variations are working well
 * after the gain refinement. The remaining issue is that some fragment cuts
 * are perceptually too abrupt. A micro-fade is desired at slice boundaries,
 * similar to de-click treatment previously needed in Freeze/Slice workflows."
 */

const source = () => encodeWav(synthesize(9, 8000, 1, 5000));

function generateSet(cfg: typeof FRAGMENT_EXPLORATION_V1, baseSeed = 1000, count = 8) {
  const src = source();
  return Array.from({ length: count }, (_, i) => {
    const seed = cfg.variationSeed(baseSeed, i);
    return { seed, bytes: cfg.render(src, seed) };
  });
}

// Golden hashes, unaffected by this change: 1.0.0 captured in the gain-consistency
// work, 1.1.0 captured from the same reference corpus before boundary fades existed.
const V1_0_0_GOLDEN = [
  '19e8cbc4f1', '367f284d40', '7408de9428', 'dd363e533e',
  '27062eaa9c', '443266ecb9', '586c5a1b93', '7c4ddfaa32',
];
const V1_1_0_GOLDEN = [
  'ec99208e04', 'da06a56c2e', '61467eabf2', '3822c284a1',
  'e8d94f85dc', 'a284a303dd', '57232e689e', '9bede55c85',
];

test('1. fragment-exploration-v1@1.0.0 reference hashes are unchanged', () => {
  const rows = generateSet(FRAGMENT_EXPLORATION_V1);
  assert.deepEqual(rows.map((r) => contentHash(r.bytes).slice(0, 10)), V1_0_0_GOLDEN);
});

test('2. fragment-exploration-v1@1.1.0 reference hashes are unchanged', () => {
  const rows = generateSet(FRAGMENT_EXPLORATION_V1_1);
  assert.deepEqual(rows.map((r) => contentHash(r.bytes).slice(0, 10)), V1_1_0_GOLDEN);
});

test('3. fragment-exploration-v1@1.2.0 is deterministic', () => {
  const a = generateSet(FRAGMENT_EXPLORATION_V1_2);
  const b = generateSet(FRAGMENT_EXPLORATION_V1_2);
  assert.deepEqual(a.map((r) => contentHash(r.bytes)), b.map((r) => contentHash(r.bytes)));
});

test('4. the configured fade duration converts correctly at 44.1kHz', () => {
  assert.equal(fadeFramesForSampleRate(44100), 221);
  assert.equal(fadeFramesForSampleRate(44100, PREVIEW_BOUNDARY_FADE_MS), 221);
});

test('5. the configured fade duration converts correctly at 48kHz', () => {
  assert.equal(fadeFramesForSampleRate(48000), 240);
});

test('6. fade boundaries are frame-aligned', () => {
  // Two channels, 40 frames: the fade must operate on whole frames, never
  // split a frame's channels across the fade/no-fade line.
  const channels = 2;
  const frames = 40;
  const samples = new Int16Array(frames * channels).fill(20000);
  const out = applyBoundaryFade(samples, channels, 8, 8);
  // Frame 8 is the first frame past the fade-in window: both its channels
  // must be fully unfaded (equal to the original 20000), never partially so.
  assert.equal(out[8 * channels], 20000);
  assert.equal(out[8 * channels + 1], 20000);
  // Frame 7 (last fade-in frame) must be fully ramped: gain = 8/8 = 1.
  assert.equal(out[7 * channels], 20000);
});

test('7. all channels of one frame receive the same fade coefficient', () => {
  const channels = 3;
  const frames = 40;
  const samples = new Int16Array(frames * channels);
  for (let f = 0; f < frames; f++) {
    samples[f * channels] = 10000; samples[f * channels + 1] = 20000; samples[f * channels + 2] = 30000;
  }
  const out = applyBoundaryFade(samples, channels, 8, 0);
  for (let f = 0; f < 8; f++) {
    const ratios = [0, 1, 2].map((c) => out[f * channels + c]! / samples[f * channels + c]!);
    assert.ok(Math.abs(ratios[0]! - ratios[1]!) < 1e-6 && Math.abs(ratios[1]! - ratios[2]!) < 1e-6,
      `frame ${f}: all channels must share one gain, got ${ratios}`);
  }
});

test('8. direct fragment-to-fragment boundaries receive fade-out/fade-in', () => {
  // A constant-amplitude signal split into two adjacent, unfaded fragments
  // would show zero discontinuity trivially; use opposite-sign fragments so a
  // real fade is required to avoid a sharp step, and confirm one is present.
  const channels = 1;
  const a = new Int16Array(40).fill(16000);
  const b = new Int16Array(40).fill(-16000);
  const fadedA = applyBoundaryFade(a, channels, 0, 8);
  const fadedB = applyBoundaryFade(b, channels, 8, 0);
  assert.ok(Math.abs(fadedA[39]!) < Math.abs(a[39]!), 'end of A is attenuated toward the boundary');
  assert.ok(Math.abs(fadedB[0]!) < Math.abs(b[0]!), 'start of B is attenuated from the boundary');
  const jump = Math.abs(fadedA[39]! - fadedB[0]!);
  const unfadedJump = Math.abs(a[39]! - b[0]!);
  assert.ok(jump < unfadedJump, 'the fade reduces the step at the boundary');
});

test('9. fragment-to-silence boundaries fade the fragment toward zero', () => {
  const channels = 1;
  const fragment = new Int16Array(40).fill(16000);
  const faded = applyBoundaryFade(fragment, channels, 0, 8);
  assert.equal(faded[39], 0, 'the very last sample reaches exactly zero before the silence');
  assert.ok(faded[32]! < fragment[32]!, 'earlier samples in the fade window are also reduced');
  assert.equal(faded[0], fragment[0], 'samples outside the fade window are untouched');
});

test('10. silence-to-fragment boundaries fade the following fragment from zero', () => {
  const channels = 1;
  const fragment = new Int16Array(40).fill(16000);
  const faded = applyBoundaryFade(fragment, channels, 8, 0);
  assert.ok(faded[0]! < fragment[0]! && faded[0]! > 0, 'first sample starts low but not silent (0/8 excluded)');
  assert.equal(faded[7], fragment[7], 'the fade reaches full amplitude by its last frame');
  assert.equal(faded[39], fragment[39], 'samples outside the fade window are untouched');
});

test('11. reversed fragments receive the same boundary treatment as forward ones', () => {
  const channels = 1;
  const forward = Int16Array.from({ length: 40 }, (_, i) => (i - 20) * 800);
  const reversed = Int16Array.from(forward).reverse();
  const fadedForward = applyBoundaryFade(forward, channels, 8, 8);
  const fadedReversed = applyBoundaryFade(reversed, channels, 8, 8);
  // The fade is applied identically regardless of the sample values within —
  // reversal happens upstream, the fade only ever sees "a piece of audio".
  for (let i = 0; i < 8; i++) {
    const gainForward = fadedForward[i]! / forward[i]!;
    const gainReversed = fadedReversed[i]! / reversed[i]!;
    if (Number.isFinite(gainForward) && Number.isFinite(gainReversed)) {
      assert.ok(Math.abs(gainForward - gainReversed) < 1e-6);
    }
  }
});

test('12. short fragments reduce their fade length safely', () => {
  const channels = 1;
  const tiny = new Int16Array(8).fill(16000); // 8 frames: max fade per side = floor(8/4) = 2
  const faded = applyBoundaryFade(tiny, channels, 221, 221); // full 44.1kHz fade requested
  assert.equal(faded[2], tiny[2], 'frame 2 (past the capped 2-frame fade-in) is untouched');
  assert.equal(faded[5], tiny[5], 'frame 5 (before the capped fade-out) is untouched');
  assert.notEqual(faded[0], tiny[0], 'fade-in still applied, just shortened');
  assert.notEqual(faded[7], tiny[7], 'fade-out still applied, just shortened');

  const microscopic = new Int16Array(2).fill(16000); // floor(2/4) = 0: no room for any fade
  const untouched = applyBoundaryFade(microscopic, channels, 221, 221);
  assert.deepEqual(Array.from(untouched), Array.from(microscopic), 'zero-length fade leaves the piece unchanged');
});

test('13. fade-in and fade-out never overlap inside one fragment', () => {
  const channels = 1;
  const frames = 40;
  const samples = new Int16Array(frames * channels).fill(16000);
  // Request fades that would overlap if not capped (20 + 20 > 40).
  const faded = applyBoundaryFade(samples, channels, 20, 20);
  const maxPerSide = Math.floor(frames / 4); // = 10
  // The midpoint frames, outside both capped windows, must be untouched.
  for (let f = maxPerSide; f < frames - maxPerSide; f++) {
    assert.equal(faded[f], samples[f], `frame ${f} should sit outside both fade windows`);
  }
});

test('14. output duration is unchanged relative to the equivalent 1.1.0 structure', () => {
  const before = generateSet(FRAGMENT_EXPLORATION_V1_1);
  const after = generateSet(FRAGMENT_EXPLORATION_V1_2);
  for (let i = 0; i < before.length; i++) {
    assert.equal(decodeWav(after[i]!.bytes).samples.length, decodeWav(before[i]!.bytes).samples.length,
      `variation ${i}: fading must not add or remove a single frame`);
  }
});

test('15. channel count is unchanged', () => {
  const rows = generateSet(FRAGMENT_EXPLORATION_V1_2);
  for (const row of rows) assert.equal(decodeWav(row.bytes).channels, 1);
});

test('16. no output sample clips', () => {
  const rows = generateSet(FRAGMENT_EXPLORATION_V1_2);
  for (const row of rows) {
    const samples = decodeWav(row.bytes).samples;
    for (const s of samples) assert.ok(Math.abs(s) < 32767);
  }
});

test('17. gain-consistency behaviour remains inside its expected envelope', () => {
  const before = generateSet(FRAGMENT_EXPLORATION_V1_1).map((r) => decodeWav(r.bytes).samples);
  const after = generateSet(FRAGMENT_EXPLORATION_V1_2).map((r) => decodeWav(r.bytes).samples);
  const rms = (s: Int16Array) => {
    let sum = 0; for (const v of s) sum += (v / 32768) ** 2; return Math.sqrt(sum / s.length);
  };
  const rmsBefore = before.map(rms), rmsAfter = after.map(rms);
  const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
  assert.ok(Math.abs(spread(rmsAfter) - spread(rmsBefore)) < spread(rmsBefore) * 0.25,
    'boundary fades must not materially change the 1.1.0 gain-consistency spread');
});

test('18. identical seed, input and version produces an identical hash', () => {
  const src = source();
  const seed = FRAGMENT_EXPLORATION_V1_2.variationSeed(3000, 2);
  const a = contentHash(FRAGMENT_EXPLORATION_V1_2.render(src, seed));
  const b = contentHash(FRAGMENT_EXPLORATION_V1_2.render(src, seed));
  assert.equal(a, b);
});

test('19. different seeds remain capable of producing distinct hashes', () => {
  const rows = generateSet(FRAGMENT_EXPLORATION_V1_2);
  assert.equal(new Set(rows.map((r) => contentHash(r.bytes))).size, rows.length);
});

test('20. existing 1.0.0 and 1.1.0 manifests remain retainable by exact version', () => {
  const v1 = configurationById('fragment-exploration-v1', '1.0.0');
  const v11 = configurationById('fragment-exploration-v1', '1.1.0');
  assert.equal(v1.version, '1.0.0');
  assert.equal(v11.version, '1.1.0');
  assert.deepEqual(generateSet(v1).map((r) => contentHash(r.bytes).slice(0, 10)), V1_0_0_GOLDEN);
  assert.deepEqual(generateSet(v11).map((r) => contentHash(r.bytes).slice(0, 10)), V1_1_0_GOLDEN);
  assert.notEqual(v1.version, DEFAULT_FRAGMENT_EXPLORATION.version);
  assert.notEqual(v11.version, DEFAULT_FRAGMENT_EXPLORATION.version);
});

test('21. 1.2.0 Retain provenance records version 1.2.0', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { SqliteRecordStore } = await import('../../src/adapters/node-sqlite/record-store.ts');
  const { FsContentStore } = await import('../../src/adapters/content-fs/content-store.ts');
  const { DataRegistry } = await import('../../src/registries/data-registry.ts');
  const { registerAlchemyVocabulary } = await import('../../src/domain/alchemy/vocabulary.ts');
  const { AlchemyService } = await import('../../src/domain/alchemy/service.ts');
  const { migrate, CURRENT_SCHEMA } = await import('../../src/migrations/index.ts');
  const { selectVariation } = await import('../../src/domain/alchemy/exploration.ts');

  const dir = mkdtempSync(join(tmpdir(), 'spk-fade-'));
  const records = new SqliteRecordStore(join(dir, 'store.sqlite'), CURRENT_SCHEMA);
  await migrate(records);
  const content = new FsContentStore(join(dir, 'content'));
  const registry = new DataRegistry();
  registerAlchemyVocabulary(registry);
  const service = new AlchemyService(records, content, registry);
  const artist = await service.registerAgent({ kind: 'human', name: 'artist', version: '1' });
  const src = await service.importMaterial({ bytes: source(), filename: 'source.wav', agentId: artist.id });
  const intent = await service.createResearchIntent({ question: 'q', agentId: artist.id });

  const set = await service.runResearchConfiguration({
    materialId: src.id, configuration: FRAGMENT_EXPLORATION_V1_2,
    researchIntentId: intent.id, baseSeed: 42, variationCount: 4, agentId: artist.id });
  const r = await service.retain(selectVariation(set, 0).preview, artist.id);
  assert.equal(r.material.attributes.configurationVersion, '1.2.0');
  assert.equal(DEFAULT_FRAGMENT_EXPLORATION.version, '1.2.0',
    '1.2.0 is expected to be the current default at this point in the project');
  await records.close();
});

test('measured evidence: post-fade discontinuity is far below the pre-fade baseline', async () => {
  // Baseline (1.1.0, no boundary treatment), same reference corpus: 82
  // boundaries, mean delta 0.0615, max 0.3121, 39% exceeding a 0.05 diagnostic
  // threshold. This test re-derives 1.2.0's own boundary deltas by rebuilding
  // its pieces with the same helpers the configuration itself uses, and checks
  // the reduction is real — not a claim about perceptual quality.
  const { fragmentEvenly, sliceFragment, reverseFrames, applyGain, silence, applyBoundaryFade: fade } =
    await import('../../src/audio/operations.ts');
  const { describeParameters, fadeFramesForSampleRate: fadeFrames } =
    await import('../../src/domain/alchemy/research-configuration.ts');

  const audio = decodeWav(source());
  const deltas: number[] = [];
  for (let i = 0; i < 8; i++) {
    const seed = FRAGMENT_EXPLORATION_V1_2.variationSeed(1000, i);
    const frames = audio.samples.length / audio.channels;
    const params = describeParameters(seed, frames);
    const fragments = fragmentEvenly(frames, params.fragmentCount);
    const reversed = new Set(params.reversedFragments);
    const gap = silence(params.silenceFrames, audio.channels);
    const configuredFade = fadeFrames(audio.sampleRate);
    const parts: Int16Array[] = []; const isGap: boolean[] = [];
    params.order.forEach((fragmentIndex, position) => {
      const fragment = fragments[fragmentIndex];
      if (!fragment) return;
      let piece = sliceFragment(audio, fragment);
      if (reversed.has(fragmentIndex)) piece = reverseFrames(piece, audio.channels);
      const numerator = Math.max(3, params.gainNumerator - position);
      piece = applyGain(piece, numerator, params.gainDenominator);
      parts.push(piece); isGap.push(false);
      if (position < params.order.length - 1 && gap.length > 0) { parts.push(gap); isGap.push(true); }
    });
    for (let p = 0; p < parts.length; p++) {
      if (isGap[p]) continue;
      const fadeIn = p > 0 ? configuredFade : 0;
      const fadeOut = p < parts.length - 1 ? configuredFade : 0;
      if (fadeIn === 0 && fadeOut === 0) continue;
      parts[p] = fade(parts[p]!, audio.channels, fadeIn, fadeOut);
    }
    for (let p = 0; p < parts.length - 1; p++) {
      const a = parts[p]!, b = parts[p + 1]!;
      if (a.length === 0 || b.length === 0) continue;
      deltas.push(Math.abs(a[a.length - 1]! - b[0]!) / 32768);
    }
  }
  const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const max = Math.max(...deltas);
  const exceeding = deltas.filter((d) => d > 0.05).length;
  assert.ok(mean < 0.0615 * 0.1, `mean delta ${mean.toFixed(4)} should be far below the 0.0615 baseline`);
  assert.ok(max < 0.3121 * 0.2, `max delta ${max.toFixed(4)} should be far below the 0.3121 baseline`);
  assert.equal(exceeding, 0, 'no boundary should exceed the diagnostic threshold after fading');
});
