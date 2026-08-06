import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FRAGMENT_EXPLORATION_V1, FRAGMENT_EXPLORATION_V1_1, DEFAULT_FRAGMENT_EXPLORATION,
  configurationById, computePreviewGainCorrection, measurePreviewLevel,
  PREVIEW_TARGET_RMS, PREVIEW_GAIN_MAX_BOOST_DB, PREVIEW_GAIN_MAX_CUT_DB, PREVIEW_PEAK_CEILING,
} from '../../src/domain/alchemy/research-configuration.ts';
import { synthesize, encodeWav, decodeWav } from '../../src/audio/wav.ts';
import { contentHash } from '../../src/core/ids.ts';

/**
 * Artist feedback that motivated this change (measured evidence stays
 * separate, in docs/IMPLEMENTATION_FINDINGS.md):
 * "Variations are useful and distinct. Overall gain variation is slightly too
 * broad; preserve volume character but narrow the listening-level range."
 */

const source = () => encodeWav(synthesize(9, 8000, 1, 5000));

function measure(bytes: Uint8Array) { return measurePreviewLevel(decodeWav(bytes).samples); }

function generateSet(cfg: typeof FRAGMENT_EXPLORATION_V1, baseSeed = 1000, count = 8) {
  const src = source();
  return Array.from({ length: count }, (_, i) => {
    const seed = cfg.variationSeed(baseSeed, i);
    const bytes = cfg.render(src, seed);
    return { seed, bytes, ...measure(bytes) };
  });
}

function dbSpread(values: readonly number[]): number {
  return 20 * Math.log10(Math.max(...values) / Math.max(1e-9, Math.min(...values)));
}

// Golden hashes for 1.0.0, captured before this change. Any drift here means
// the old, already-shared configuration silently changed — that must never
// happen once a version has been used.
const V1_0_0_GOLDEN_HASHES = [
  '19e8cbc4f1', '367f284d40', '7408de9428', 'dd363e533e',
  '27062eaa9c', '443266ecb9', '586c5a1b93', '7c4ddfaa32',
];

test('1. fragment-exploration-v1@1.0.0 still produces its previous hashes', () => {
  const rows = generateSet(FRAGMENT_EXPLORATION_V1);
  assert.deepEqual(rows.map((r) => contentHash(r.bytes).slice(0, 10)), V1_0_0_GOLDEN_HASHES);
});

test('2. fragment-exploration-v1@1.1.0 produces deterministic hashes', () => {
  const a = generateSet(FRAGMENT_EXPLORATION_V1_1);
  const b = generateSet(FRAGMENT_EXPLORATION_V1_1);
  assert.deepEqual(a.map((r) => contentHash(r.bytes)), b.map((r) => contentHash(r.bytes)));
});

test('3. identical inputs and seed remain bit-identical within 1.1.0', () => {
  const src = source();
  const seed = FRAGMENT_EXPLORATION_V1_1.variationSeed(2000, 3);
  const a = FRAGMENT_EXPLORATION_V1_1.render(src, seed);
  const b = FRAGMENT_EXPLORATION_V1_1.render(src, seed);
  assert.deepEqual(Buffer.from(a), Buffer.from(b));
});

test('4. one Preview alone or inside a set produces identical bytes', () => {
  // The correction is a pure function of that Preview's own samples — it must
  // never depend on siblings. Render variation index 3 alone, and again as
  // part of the full eight; the bytes must match exactly.
  const src = source();
  const cfg = FRAGMENT_EXPLORATION_V1_1;
  const seedAlone = cfg.variationSeed(5000, 3);
  const alone = cfg.render(src, seedAlone);

  const set = generateSet(cfg, 5000, 8);
  const sameIndex = set[3]!;
  assert.equal(sameIndex.seed, seedAlone);
  assert.deepEqual(Buffer.from(alone), Buffer.from(sameIndex.bytes));
});

test('5. overall energy spread across a Preview Set is narrower than 1.0.0', () => {
  const before = generateSet(FRAGMENT_EXPLORATION_V1);
  const after = generateSet(FRAGMENT_EXPLORATION_V1_1);
  const spreadBefore = dbSpread(before.map((r) => r.rms));
  const spreadAfter = dbSpread(after.map((r) => r.rms));
  assert.ok(spreadAfter < spreadBefore,
    `expected narrower spread: ${spreadBefore.toFixed(1)}dB -> ${spreadAfter.toFixed(1)}dB`);
  assert.ok(spreadAfter < spreadBefore * 0.6, 'reduction is substantial, not marginal');
});

test('6. internal dynamic differences remain present, not flattened to one level', () => {
  const after = generateSet(FRAGMENT_EXPLORATION_V1_1);
  const rmss = after.map((r) => r.rms);
  const distinctValues = new Set(rmss.map((r) => r.toFixed(4)));
  assert.ok(distinctValues.size > 1, 'variations must not all measure identically');
  const spread = dbSpread(rmss);
  assert.ok(spread > 0.5, `some meaningful spread should remain, got ${spread.toFixed(2)}dB`);
});

test('7. silent input remains valid and causes no division error', () => {
  const silence = encodeWav({ sampleRate: 8000, channels: 1, samples: new Int16Array(2000) });
  const correction = computePreviewGainCorrection(new Int16Array(2000));
  assert.equal(correction, 1, 'no correction attempted on silence');
  const bytes = FRAGMENT_EXPLORATION_V1_1.render(silence, 42);
  const level = measure(bytes);
  assert.equal(level.rms, 0);
  assert.ok(Number.isFinite(level.rms) && Number.isFinite(level.peak), 'no NaN or Infinity');
});

test('8. a very quiet input receives only a bounded upward correction', () => {
  const quiet = new Int16Array(2000);
  for (let i = 0; i < quiet.length; i++) quiet[i] = Math.round(Math.sin(i / 10) * 50);
  const correction = computePreviewGainCorrection(quiet);
  const correctionDb = 20 * Math.log10(correction);
  assert.ok(correctionDb <= PREVIEW_GAIN_MAX_BOOST_DB + 1e-9,
    `boost ${correctionDb.toFixed(2)}dB must not exceed the ${PREVIEW_GAIN_MAX_BOOST_DB}dB bound`);
  assert.ok(correctionDb > 0, 'a quiet signal should still be boosted, not cut');
});

test('9. a very loud input receives only a bounded downward correction', () => {
  const loud = new Int16Array(2000);
  for (let i = 0; i < loud.length; i++) loud[i] = Math.round(Math.sin(i / 3) * 32000);
  const correction = computePreviewGainCorrection(loud);
  const correctionDb = 20 * Math.log10(correction);
  assert.ok(correctionDb >= -PREVIEW_GAIN_MAX_CUT_DB - 1e-9,
    `cut ${correctionDb.toFixed(2)}dB must not exceed the -${PREVIEW_GAIN_MAX_CUT_DB}dB bound`);
  assert.ok(correctionDb < 0, 'a loud signal should still be cut, not boosted');
});

test('10. no output sample clips, across the reference corpus and extreme inputs', () => {
  const rows = generateSet(FRAGMENT_EXPLORATION_V1_1);
  for (const row of rows) {
    assert.ok(row.peak <= PREVIEW_PEAK_CEILING + 1e-6, `peak ${row.peak} exceeds ceiling`);
  }
  // A near-full-scale input must still clear the safety ceiling after correction.
  const nearClip = new Int16Array(2000);
  for (let i = 0; i < nearClip.length; i++) nearClip[i] = Math.round(Math.sin(i / 2) * 32700);
  const bytes = FRAGMENT_EXPLORATION_V1_1.render(
    encodeWav({ sampleRate: 8000, channels: 1, samples: nearClip }), 3);
  const level = measure(bytes);
  assert.ok(level.peak <= PREVIEW_PEAK_CEILING + 1e-6);
  let clipped = 0;
  for (const s of decodeWav(bytes).samples) if (Math.abs(s) >= 32767) clipped++;
  assert.equal(clipped, 0);
});

test('11. stereo channel alignment is preserved: one global factor, not per-channel', () => {
  const frames = 1000;
  const stereo = new Int16Array(frames * 2);
  for (let f = 0; f < frames; f++) {
    stereo[f * 2] = Math.round(Math.sin(f / 7) * 8000);       // left, quieter
    stereo[f * 2 + 1] = Math.round(Math.sin(f / 7) * 16000);  // right, louder, same phase
  }
  const wav = encodeWav({ sampleRate: 8000, channels: 2, samples: stereo });
  const bytes = FRAGMENT_EXPLORATION_V1_1.render(wav, 11);
  const out = decodeWav(bytes);
  assert.equal(out.channels, 2);
  // The left/right peak ratio in the source is exactly 2:1; a single global
  // correction preserves that ratio exactly (subject to int16 rounding).
  let leftPeak = 0, rightPeak = 0;
  for (let i = 0; i < out.samples.length; i += 2) {
    leftPeak = Math.max(leftPeak, Math.abs(out.samples[i]!));
    rightPeak = Math.max(rightPeak, Math.abs(out.samples[i + 1]!));
  }
  assert.ok(rightPeak > 0 && leftPeak > 0);
  const ratio = rightPeak / leftPeak;
  assert.ok(Math.abs(ratio - 2) < 0.05, `L/R ratio ${ratio.toFixed(3)} should stay ~2.0`);
});

test('12. Retain provenance records the new configuration version', async () => {
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

  const dir = mkdtempSync(join(tmpdir(), 'spk-gain-'));
  const records = new SqliteRecordStore(join(dir, 'store.sqlite'), CURRENT_SCHEMA);
  await migrate(records);
  const content = new FsContentStore(join(dir, 'content'));
  const registry = new DataRegistry();
  registerAlchemyVocabulary(registry);
  const service = new AlchemyService(records, content, registry);
  const artist = await service.registerAgent({ kind: 'human', name: 'artist', version: '1' });
  const src = await service.importMaterial({
    bytes: source(), filename: 'source.wav', agentId: artist.id });
  const intent = await service.createResearchIntent({ question: 'q', agentId: artist.id });
  const experiment = await service.createExperiment({
    researchIntentId: intent.id, inputMaterialIds: [src.id],
    operation: 'exploration' as never, agentId: artist.id,
    configuration: DEFAULT_FRAGMENT_EXPLORATION, baseSeed: 42 });
  void experiment;

  const set = await service.runResearchConfiguration({
    materialId: src.id, configuration: DEFAULT_FRAGMENT_EXPLORATION,
    researchIntentId: intent.id, baseSeed: 42, variationCount: 4, agentId: artist.id });
  const r = await service.retain(selectVariation(set, 0).preview, artist.id);
  assert.equal(r.material.attributes.configurationVersion, '1.1.0');
  assert.equal(DEFAULT_FRAGMENT_EXPLORATION.version, '1.1.0');
  await records.close();
});

test('13. existing manifests recorded at 1.0.0 remain retainable', () => {
  // Old manifests were generated before this configuration existed and always
  // recorded version "1.0.0"; resolving that exact pin must return the
  // original, byte-preserving configuration — never today's default.
  const resolved = configurationById('fragment-exploration-v1', '1.0.0');
  assert.equal(resolved.version, '1.0.0');
  assert.equal(resolved, FRAGMENT_EXPLORATION_V1);
  assert.notEqual(resolved, DEFAULT_FRAGMENT_EXPLORATION);

  const bySeed = generateSet(resolved);
  assert.deepEqual(bySeed.map((r) => contentHash(r.bytes).slice(0, 10)), V1_0_0_GOLDEN_HASHES,
    'resolving by exact version reproduces the original bytes exactly');

  // Omitting the version resolves to the current default, not 1.0.0.
  const defaulted = configurationById('fragment-exploration-v1');
  assert.equal(defaulted.version, '1.1.0');

  assert.throws(() => configurationById('fragment-exploration-v1', '9.9.9'),
    /unknown research configuration version/);
});

test('reference corpus measurement: PREVIEW_TARGET_RMS sits inside the observed range', () => {
  const rows = generateSet(FRAGMENT_EXPLORATION_V1);
  const rmss = rows.map((r) => r.rms);
  assert.ok(PREVIEW_TARGET_RMS >= Math.min(...rmss) && PREVIEW_TARGET_RMS <= Math.max(...rmss),
    'the target should sit inside the reference spread, not drag it to one extreme');
});
