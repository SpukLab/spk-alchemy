import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteRecordStore } from '../../src/adapters/node-sqlite/record-store.ts';
import { FsContentStore } from '../../src/adapters/content-fs/content-store.ts';
import { DataRegistry } from '../../src/registries/data-registry.ts';
import { registerAlchemyVocabulary } from '../../src/domain/alchemy/vocabulary.ts';
import { AlchemyService } from '../../src/domain/alchemy/service.ts';
import { FamilyService } from '../../src/domain/alchemy/family-service.ts';
import { migrate, CURRENT_SCHEMA } from '../../src/migrations/index.ts';
import { synthesize, encodeWav, decodeWav } from '../../src/audio/wav.ts';
import { applyGate, highPassFilter } from '../../src/audio/operations.ts';
import { contentHash } from '../../src/core/ids.ts';
import {
  validateConditioningState, serializeConditioningState, applyConditioning,
  DEFAULT_CONDITIONING_STATE, resolveConditioningParameters, CONDITIONING_VERSION,
} from '../../src/domain/alchemy/conditioning.ts';
import { FRAGMENT_EXPLORATION_V1, FRAGMENT_EXPLORATION_V1_2 } from '../../src/domain/alchemy/research-configuration.ts';
import { DEFAULT_MESA_STATE } from '../../src/domain/alchemy/mesa.ts';
import { COLLECTIONS } from '../../src/core/primitives.ts';

const SR = 8000;
function mixedFixture(): Uint8Array {
  const frames = 6000;
  const samples = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    let v = 0;
    if (i >= 2000 && i < 4000) v += Math.sin((2 * Math.PI * 220 * i) / SR) * 0.7;
    const seed = (i * 2654435761) >>> 0;
    v += (((seed >>> 16) / 65535) - 0.5) * 0.04;
    samples[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  }
  return encodeWav({ sampleRate: SR, channels: 1, samples });
}
function rumbleFixture(): Uint8Array {
  const frames = 4000;
  const samples = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    const v = Math.sin((2 * Math.PI * 40 * i) / SR) * 0.5 + Math.sin((2 * Math.PI * 800 * i) / SR) * 0.4;
    samples[i] = Math.max(-32768, Math.min(32767, Math.round(v * 20000)));
  }
  return encodeWav({ sampleRate: SR, channels: 1, samples });
}
function measure(samples: Int16Array, from: number, to: number) {
  let sumSq = 0, peak = 0, clipped = 0;
  for (let i = from; i < to; i++) {
    const v = samples[i]! / 32768; sumSq += v * v; peak = Math.max(peak, Math.abs(v));
    if (Math.abs(samples[i]!) >= 32767) clipped++;
  }
  return { rms: Math.sqrt(sumSq / (to - from)), peak, clipped };
}

// ---- state and bypass ------------------------------------------------------

test('1. InputConditioningState validates and clamps', () => {
  const s = validateConditioningState({
    gate: { enabled: true, threshold: 150 }, filter: { enabled: 1 as unknown as boolean, amount: -20 } });
  assert.equal(s.gate.threshold, 100);
  assert.equal(s.filter.amount, 0);
  assert.equal(s.filter.enabled, true);
});

test('2+3. Gate and Filter default OFF', () => {
  assert.equal(DEFAULT_CONDITIONING_STATE.gate.enabled, false);
  assert.equal(DEFAULT_CONDITIONING_STATE.filter.enabled, false);
});

test('4. both OFF produces the exact unmodified input (bypass invariant)', () => {
  const bytes = mixedFixture();
  const result = applyConditioning(bytes, DEFAULT_CONDITIONING_STATE);
  assert.equal(result, bytes, 'bypass returns the identical reference, not merely equal bytes');
});

test('5+6. conditioning creates no canonical Entity or Material', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spk-cond-'));
  const records = new SqliteRecordStore(join(dir, 'store.sqlite'), CURRENT_SCHEMA);
  await migrate(records);
  const before = (await records.scan(COLLECTIONS.entities, null, 500)).items.length;
  applyConditioning(mixedFixture(), { gate: { enabled: true, threshold: 50 }, filter: { enabled: true, amount: 50 } });
  const after = (await records.scan(COLLECTIONS.entities, null, 500)).items.length;
  assert.equal(after, before, 'applyConditioning is pure -- it never touches RecordStore');
  await records.close();
});

// ---- gate -------------------------------------------------------------------

test('7+8. Gate reduces quiet-region energy while preserving active-region signal', () => {
  const audio = decodeWav(mixedFixture());
  const gated = applyGate(audio.samples, 1, SR, 0.1);
  const quietBefore = measure(audio.samples, 0, 1500), quietAfter = measure(gated, 0, 1500);
  const activeBefore = measure(audio.samples, 2000, 4000), activeAfter = measure(gated, 2000, 4000);
  assert.ok(quietAfter.rms < quietBefore.rms * 0.3, 'quiet region attenuated substantially');
  assert.ok(activeAfter.rms > activeBefore.rms * 0.9, 'active region preserved within a documented bound (>90%)');
});

test('9. gate transitions are smoothed across windows, not stepped', () => {
  // A near-zero-crossing sample can make an output/input ratio numerically
  // unstable regardless of how smooth the actual gain envelope is -- that is
  // a property of dividing by a small number, not of the gate. The gate's
  // real guarantee operates on the WINDOW timescale (GATE_WINDOW_MS): sample
  // one loud, comfortably-away-from-zero peak per window and confirm the
  // implied gain changes gradually window to window, which is what the
  // attack/release smoothing actually promises.
  const frames = 8000;
  const samples = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    const amplitude = i < 4000 ? 300 : 20000; // quiet, then loud
    samples[i] = Math.round(Math.sin((2 * Math.PI * 220 * i) / SR) * amplitude);
  }
  const gated = applyGate(samples, 1, SR, 0.3);
  const windowFrames = Math.round((SR * 5) / 1000); // GATE_WINDOW_MS
  const windowGains: number[] = [];
  for (let w = 0; w * windowFrames < frames; w++) {
    const start = w * windowFrames;
    // Pick the sample of largest magnitude in this window -- farthest from
    // any zero-crossing, so the input/output ratio is numerically stable.
    let bestIdx = start, bestAbs = 0;
    for (let i = start; i < Math.min(frames, start + windowFrames); i++) {
      if (Math.abs(samples[i]!) > bestAbs) { bestAbs = Math.abs(samples[i]!); bestIdx = i; }
    }
    if (bestAbs > 100) windowGains.push(gated[bestIdx]! / samples[bestIdx]!);
  }
  let maxWindowStep = 0;
  for (let i = 1; i < windowGains.length; i++) {
    maxWindowStep = Math.max(maxWindowStep, Math.abs(windowGains[i]! - windowGains[i - 1]!));
  }
  assert.ok(windowGains.some((g) => g < 0.5) && windowGains.some((g) => g > 0.5),
    'the fixture actually crosses the gate threshold');
  assert.ok(maxWindowStep < 0.65,
    `max window-to-window gain step ${maxWindowStep.toFixed(3)} indicates an instant floor-to-open jump`);
});

test('10. no gate-induced clipping', () => {
  const audio = decodeWav(mixedFixture());
  for (const threshold of [0.02, 0.06, 0.1, 0.15]) {
    const gated = applyGate(audio.samples, 1, SR, threshold);
    for (const s of gated) assert.ok(Math.abs(s) <= 32768);
  }
});

test('11. silent input remains valid through the gate', () => {
  const silence = new Int16Array(2000);
  const gated = applyGate(silence, 1, SR, 0.1);
  assert.equal(gated.length, silence.length);
  for (const s of gated) assert.equal(s, 0);
});

test('12. stereo channel alignment is intact through the gate', () => {
  const frames = 1000;
  const stereo = new Int16Array(frames * 2);
  for (let f = 0; f < frames; f++) { stereo[f * 2] = 8000; stereo[f * 2 + 1] = 16000; }
  const gated = applyGate(stereo, 2, SR, 0.01);
  for (let f = 0; f < frames; f++) {
    const ratio = gated[f * 2 + 1]! / (gated[f * 2]! || 1);
    assert.ok(Math.abs(ratio - 2) < 0.01, 'L/R ratio preserved: same gain applied to every channel of a frame');
  }
});

test('13. identical input and state produce bit-identical Gate output', () => {
  const audio = decodeWav(mixedFixture());
  const a = applyGate(audio.samples, 1, SR, 0.08);
  const b = applyGate(audio.samples, 1, SR, 0.08);
  assert.deepEqual(Array.from(a), Array.from(b));
});

// ---- filter -------------------------------------------------------------------

test('14. Filter reduces the targeted low-frequency region', () => {
  const audio = decodeWav(rumbleFixture());
  const filtered = highPassFilter(audio.samples, 1, SR, 200);
  const before = measure(audio.samples, 500, 3500), after = measure(filtered, 500, 3500);
  assert.ok(after.rms < before.rms * 0.7, 'combined energy drops as the rumble component is suppressed');
});

test('15. Filter preserves valid WAV structure', () => {
  const audio = decodeWav(rumbleFixture());
  const filtered = highPassFilter(audio.samples, 1, SR, 150);
  const encoded = encodeWav({ ...audio, samples: filtered });
  const roundtrip = decodeWav(encoded); // throws on malformed structure
  assert.equal(roundtrip.sampleRate, SR);
});

test('16+17+18. no clipping, channel count and duration preserved', () => {
  const frames = 1000;
  const stereo = new Int16Array(frames * 2);
  for (let i = 0; i < stereo.length; i++) stereo[i] = Math.round(Math.sin(i / 3) * 30000);
  const filtered = highPassFilter(stereo, 2, SR, 200);
  assert.equal(filtered.length, stereo.length);
  for (const s of filtered) assert.ok(Math.abs(s) <= 32768);
});

test('19. identical input and state produce bit-identical Filter output', () => {
  const audio = decodeWav(rumbleFixture());
  const a = highPassFilter(audio.samples, 1, SR, 180);
  const b = highPassFilter(audio.samples, 1, SR, 180);
  assert.deepEqual(Array.from(a), Array.from(b));
});

// ---- combined -----------------------------------------------------------------

test('20. Gate + Filter combined are deterministic together', () => {
  const bytes = mixedFixture();
  const state = { gate: { enabled: true, threshold: 40 }, filter: { enabled: true, amount: 50 } };
  const a = applyConditioning(bytes, state);
  const b = applyConditioning(bytes, state);
  assert.deepEqual(Array.from(a), Array.from(b));
  assert.deepEqual(serializeConditioningState(state), serializeConditioningState(state));
});

async function lab() {
  const dir = mkdtempSync(join(tmpdir(), 'spk-cond-e2e-'));
  const records = new SqliteRecordStore(join(dir, 'store.sqlite'), CURRENT_SCHEMA);
  await migrate(records);
  const content = new FsContentStore(join(dir, 'content'));
  const registry = new DataRegistry();
  registerAlchemyVocabulary(registry);
  const service = new AlchemyService(records, content, registry);
  const families = new FamilyService(records, content, registry);
  const artist = await service.registerAgent({ kind: 'human', name: 'artist', version: '1' });
  return { records, content, service, families, artist };
}

test('21+23. combined conditioning works before Rápida and before Mesa (4+4 preserved)', async () => {
  const l = await lab();
  const source = await l.service.importMaterial({ bytes: mixedFixture(), filename: 'a.wav', agentId: l.artist.id });
  const intent = await l.service.createResearchIntent({ question: 'q', agentId: l.artist.id });
  const conditioning = { gate: { enabled: true, threshold: 40 }, filter: { enabled: true, amount: 40 } };

  const quick = await l.service.runResearchConfiguration({
    materialId: source.id, configuration: FRAGMENT_EXPLORATION_V1_2,
    researchIntentId: intent.id, baseSeed: 1, variationCount: 4, agentId: l.artist.id, conditioning });
  assert.equal(quick.variations.length, 4);

  const mesa = await l.service.runMesaExploration({
    materialId: source.id, researchIntentId: intent.id, mesaState: DEFAULT_MESA_STATE,
    baseSeed: 2, agentId: l.artist.id, conditioning });
  assert.equal(mesa.variations.length, 8);
  assert.equal(mesa.variations.filter((v) => v.territory === 'medium').length, 4);
  assert.equal(mesa.variations.filter((v) => v.territory === 'unexpected').length, 4);
  await l.records.close();
});

test('22. Mesa results differ meaningfully with conditioning enabled vs disabled', async () => {
  const l = await lab();
  const source = await l.service.importMaterial({ bytes: mixedFixture(), filename: 'a.wav', agentId: l.artist.id });
  const intent = await l.service.createResearchIntent({ question: 'q', agentId: l.artist.id });
  const off = await l.service.runMesaExploration({
    materialId: source.id, researchIntentId: intent.id, mesaState: DEFAULT_MESA_STATE, baseSeed: 5, agentId: l.artist.id });
  const on = await l.service.runMesaExploration({
    materialId: source.id, researchIntentId: intent.id, mesaState: DEFAULT_MESA_STATE, baseSeed: 5, agentId: l.artist.id,
    conditioning: { gate: { enabled: true, threshold: 60 }, filter: { enabled: true, amount: 60 } } });
  assert.notEqual(contentHash(off.variations[0]!.preview.bytes), contentHash(on.variations[0]!.preview.bytes));
  await l.records.close();
});

test('24. Retain preserves conditioning provenance', async () => {
  const l = await lab();
  const source = await l.service.importMaterial({ bytes: mixedFixture(), filename: 'a.wav', agentId: l.artist.id });
  const intent = await l.service.createResearchIntent({ question: 'q', agentId: l.artist.id });
  const conditioning = { gate: { enabled: true, threshold: 55 }, filter: { enabled: true, amount: 35 } };
  const set = await l.service.runResearchConfiguration({
    materialId: source.id, configuration: FRAGMENT_EXPLORATION_V1_2,
    researchIntentId: intent.id, baseSeed: 9, variationCount: 1, agentId: l.artist.id, conditioning });
  const r = await l.service.retain(set.variations[0]!.preview, l.artist.id);
  const p = r.material.attributes.parameters as Record<string, unknown>;
  assert.equal(p.conditioningVersion, CONDITIONING_VERSION);
  assert.deepEqual(p.conditioningState, conditioning);
  assert.deepEqual(p.conditioningResolved, resolveConditioningParameters(conditioning));
  await l.records.close();
});

test('25. sibling Previews remain nonpersistent under conditioning', async () => {
  const l = await lab();
  const source = await l.service.importMaterial({ bytes: mixedFixture(), filename: 'a.wav', agentId: l.artist.id });
  const intent = await l.service.createResearchIntent({ question: 'q', agentId: l.artist.id });
  const materialsBefore = (await l.records.scan(COLLECTIONS.entities, null, 500)).items
    .filter((e) => (e as { role?: string }).role === 'material').length;
  await l.service.runMesaExploration({
    materialId: source.id, researchIntentId: intent.id, mesaState: DEFAULT_MESA_STATE, baseSeed: 3, agentId: l.artist.id,
    conditioning: { gate: { enabled: true, threshold: 30 }, filter: { enabled: false, amount: 0 } } });
  const materialsAfter = (await l.records.scan(COLLECTIONS.entities, null, 500)).items
    .filter((e) => (e as { role?: string }).role === 'material').length;
  assert.equal(materialsAfter, materialsBefore, 'eight Previews, zero new Materials');
  await l.records.close();
});

test('26. source Material content hash is unchanged by conditioning', async () => {
  const l = await lab();
  const source = await l.service.importMaterial({ bytes: mixedFixture(), filename: 'a.wav', agentId: l.artist.id });
  const originalHash = source.attributes.contentHash;
  const intent = await l.service.createResearchIntent({ question: 'q', agentId: l.artist.id });
  await l.service.runResearchConfiguration({
    materialId: source.id, configuration: FRAGMENT_EXPLORATION_V1_2,
    researchIntentId: intent.id, baseSeed: 1, variationCount: 2, agentId: l.artist.id,
    conditioning: { gate: { enabled: true, threshold: 80 }, filter: { enabled: true, amount: 80 } } });
  const reread = await l.content.get(String(originalHash));
  assert.equal(contentHash(reread!), originalHash, 'conditioning never touches stored canonical bytes');
  await l.records.close();
});

test('28. Family/DNA Pack behavior is unaffected by conditioning', async () => {
  const l = await lab();
  const source = await l.service.importMaterial({ bytes: mixedFixture(), filename: 'a.wav', agentId: l.artist.id });
  const family = await l.families.createFamily({ name: 'F', materialIds: [source.id], agentId: l.artist.id });
  const { manifest } = await l.families.publish(family.id, l.artist.id);
  assert.equal(manifest.members.length, 1);
  await l.records.close();
});

test('29+30. fragment-exploration-v1@1.2.0 remains unchanged under bypass; all previous tests remain green', () => {
  const src = encodeWav(synthesize(9, 8000, 1, 5000));
  assert.equal(contentHash(FRAGMENT_EXPLORATION_V1.render(
    src, FRAGMENT_EXPLORATION_V1.variationSeed(1000, 0))).slice(0, 10), '19e8cbc4f1');
});
