import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteRecordStore } from '../../src/adapters/node-sqlite/record-store.ts';
import { FsContentStore } from '../../src/adapters/content-fs/content-store.ts';
import { DataRegistry } from '../../src/registries/data-registry.ts';
import { registerAlchemyVocabulary, LIFECYCLE } from '../../src/domain/alchemy/vocabulary.ts';
import { AlchemyService } from '../../src/domain/alchemy/service.ts';
import { AlchemyQueries } from '../../src/query/queries.ts';
import { migrate, CURRENT_SCHEMA } from '../../src/migrations/index.ts';
import { synthesize, encodeWav, decodeWav } from '../../src/audio/wav.ts';
import { FRAGMENT_EXPLORATION_V1, configurationById } from '../../src/domain/alchemy/research-configuration.ts';
import { ComparisonGroup, selectVariation } from '../../src/domain/alchemy/exploration.ts';
import { COLLECTIONS } from '../../src/core/primitives.ts';

async function lab() {
  const dir = mkdtempSync(join(tmpdir(), 'spk-explore-'));
  const records = new SqliteRecordStore(join(dir, 'store.sqlite'), CURRENT_SCHEMA);
  await migrate(records);
  const content = new FsContentStore(join(dir, 'content'));
  const data = new DataRegistry();
  registerAlchemyVocabulary(data);
  const service = new AlchemyService(records, content, data);
  const queries = new AlchemyQueries(records, content);
  const artist = await service.registerAgent({ kind: 'human', name: 'artist', version: '1' });
  const source = await service.importMaterial({
    bytes: encodeWav(synthesize(9, 8000, 1, 4000)), filename: 'src.wav', agentId: artist.id });
  const intent = await service.createResearchIntent({
    question: 'investigate liquid rhythmic material', agentId: artist.id });
  return { records, content, service, queries, artist, source, intent };
}

const materialCount = async (l: Awaited<ReturnType<typeof lab>>): Promise<number> =>
  (await l.records.scan(COLLECTIONS.entities, null, 500)).items
    .filter((e) => (e as { role?: string }).role === 'material').length;

const explore = (l: Awaited<ReturnType<typeof lab>>, seed = 1000, count = 8, materialId?: string) =>
  l.service.runResearchConfiguration({
    materialId: materialId ?? l.source.id, configuration: FRAGMENT_EXPLORATION_V1,
    researchIntentId: l.intent.id, baseSeed: seed, variationCount: count, agentId: l.artist.id });

test('1. one ResearchConfiguration generates the requested number of Previews', async () => {
  const l = await lab();
  const set = await explore(l, 1000, 8);
  assert.equal(set.variations.length, 8);
  assert.equal(set.configurationId, 'fragment-exploration-v1');
  assert.equal(set.configurationVersion, '1.0.0');
  assert.deepEqual(set.variations.map((v) => v.index), [0, 1, 2, 3, 4, 5, 6, 7]);
  for (const v of set.variations) {
    const audio = decodeWav(v.preview.bytes);
    assert.ok(audio.samples.length > 0, 'each variation is a valid non-empty WAV');
  }
  await l.records.close();
});

test('2. Preview generation persists no Material Entities', async () => {
  const l = await lab();
  const before = await materialCount(l);
  await explore(l, 1000, 8);
  assert.equal(await materialCount(l), before, 'eight Previews, zero new Materials');
  await l.records.close();
});

test('3. identical inputs, versions, parameters and seeds produce bit-identical sets', async () => {
  const l = await lab();
  const a = await explore(l, 1000, 8);
  const b = await explore(l, 1000, 8);
  assert.deepEqual(a.variations.map((v) => v.preview.contentHash),
                   b.variations.map((v) => v.preview.contentHash));
  for (let i = 0; i < a.variations.length; i++) {
    assert.deepEqual(Buffer.from(a.variations[i]!.preview.bytes),
                     Buffer.from(b.variations[i]!.preview.bytes), `variation ${i} bit-identical`);
  }
  await l.records.close();
});

test('4. different seeds produce different hashes', async () => {
  const l = await lab();
  const a = await explore(l, 1000, 8);
  const b = await explore(l, 2000, 8);
  const ha = a.variations.map((v) => v.preview.contentHash);
  const hb = b.variations.map((v) => v.preview.contentHash);
  assert.equal(new Set(ha).size, 8, 'variations within a set are distinct');
  assert.equal(ha.filter((h) => hb.includes(h)).length, 0, 'no overlap across base seeds');
  await l.records.close();
});

test('5. each Preview has an independently traceable variation seed', async () => {
  const l = await lab();
  const set = await explore(l, 1000, 8);
  const seeds = set.variations.map((v) => v.seed);
  assert.equal(new Set(seeds).size, 8, 'seeds are unique');
  for (const v of set.variations) {
    assert.equal(v.seed, FRAGMENT_EXPLORATION_V1.variationSeed(1000, v.index));
    assert.equal(v.preview.exploration?.seed, v.seed);
    assert.equal(v.preview.exploration?.variationIndex, v.index);
    assert.ok(v.derivedParameters.fragmentCount >= 3 && v.derivedParameters.fragmentCount <= 8);
  }
  await l.records.close();
});

test('6. Discard leaves no Material Entity', async () => {
  const l = await lab();
  const set = await explore(l, 1000, 8);
  const before = await materialCount(l);
  for (const v of set.variations) l.service.discardPreview(v.preview);
  assert.equal(await materialCount(l), before);
  const transitions = (await l.records.scan(COLLECTIONS.transitions, null, 500)).items;
  assert.equal(transitions.filter((t) => (t as { kind?: string }).kind === 'retain').length, 0);
  await l.records.close();
});

test('7+9. Retain creates exactly one Material and does not persist siblings', async () => {
  const l = await lab();
  const set = await explore(l, 1000, 8);
  const before = await materialCount(l);
  const chosen = selectVariation(set, 3);
  const r = await l.service.retain(chosen.preview, l.artist.id, 'keeper');
  assert.equal(r.created, true);
  assert.equal(await materialCount(l), before + 1, 'exactly one new Material for eight Previews');
  assert.equal(r.material.lifecycleState, LIFECYCLE.retained);
  await l.records.close();
});

test('8. the retained Entity preserves configuration and seed provenance', async () => {
  const l = await lab();
  const set = await explore(l, 1000, 8);
  const chosen = selectVariation(set, 5);
  const r = await l.service.retain(chosen.preview, l.artist.id);
  const a = r.material.attributes;
  assert.equal(a.origin, 'exploration');
  assert.equal(a.configurationId, 'fragment-exploration-v1');
  assert.equal(a.configurationVersion, '1.0.0');
  assert.equal(a.variationIndex, 5);
  assert.equal(a.seed, chosen.seed);
  assert.equal(a.implementationVersion, '1.0.0');
  assert.equal(a.contentHash, chosen.preview.contentHash);

  // The Experiment carries the operation sequence, so two variations can be
  // compared on why they differ: same sequence, different seed.
  const io = await l.queries.experimentInputsOutputs(chosen.preview.experimentId);
  assert.deepEqual(io.inputs.map((i) => i.id), [l.source.id]);
  const experiment = await l.records.get(COLLECTIONS.entities, chosen.preview.experimentId);
  const ea = (experiment as unknown as { attributes: Record<string, unknown> }).attributes;
  assert.deepEqual(ea.operationSequence,
    ['fragment', 'reorder', 'reverse', 'space', 'gain', 'reconstruct']);
  assert.equal(ea.baseSeed, 1000);
  await l.records.close();
});

test('10+11. promoted appear in Inventory, rejected stay outside', async () => {
  const l = await lab();
  const set = await explore(l, 1000, 8);
  const keep = await l.service.retain(selectVariation(set, 0).preview, l.artist.id);
  const drop = await l.service.retain(selectVariation(set, 1).preview, l.artist.id);
  await l.service.promote(keep.material.id, l.artist.id);
  await l.service.reject(drop.material.id, l.artist.id, 'too sparse');

  const inv = await l.queries.promotedMaterials(undefined, 100);
  assert.ok(inv.items.some((m) => m.id === keep.material.id));
  assert.ok(!inv.items.some((m) => m.id === drop.material.id));
  const rejected = await l.queries.materialsByLifecycle(LIFECYCLE.rejected);
  assert.ok(rejected.items.some((m) => m.id === drop.material.id));
  await l.records.close();
});

test('12+13. a retained result feeds a second exploration with correct genealogy', async () => {
  const l = await lab();
  const set1 = await explore(l, 1000, 4);
  const b = await l.service.retain(selectVariation(set1, 2).preview, l.artist.id);
  await l.service.promote(b.material.id, l.artist.id);

  // B is an ordinary Material: no special handling for derived material.
  const set2 = await explore(l, 5000, 4, b.material.id);
  assert.equal(set2.variations.length, 4);
  const c = await l.service.retain(selectVariation(set2, 1).preview, l.artist.id);
  await l.service.promote(c.material.id, l.artist.id);

  const ancestors = await l.queries.ancestors(c.material.id);
  assert.deepEqual(ancestors.nodes.map((n) => n.id), [b.material.id, l.source.id],
    'C -> B -> A resolved in order');
  assert.deepEqual(ancestors.nodes.map((n) => n.depth), [1, 2]);

  const descendants = await l.queries.descendants(l.source.id);
  assert.deepEqual(descendants.nodes.map((n) => n.id).sort(),
    [b.material.id, c.material.id].sort(), 'A reaches both generations');
  await l.records.close();
});

test('14. temporary comparison groups create no canonical Entity', async () => {
  const l = await lab();
  const set = await explore(l, 1000, 4);
  const entitiesBefore = (await l.records.scan(COLLECTIONS.entities, null, 500)).items.length;
  const relsBefore = (await l.records.scan(COLLECTIONS.relationships, null, 500)).items.length;
  const knowledgeBefore = (await l.records.scan(COLLECTIONS.knowledge, null, 500)).items.length;

  const group = new ComparisonGroup();
  for (const v of set.variations) group.add(v.preview.stagingRef, 'preview', `v${v.index}`);
  group.add(l.source.id, 'material', 'source');
  assert.equal(group.size(), 5);
  assert.deepEqual(group.entries().map((e) => e.order), [0, 1, 2, 3, 4]);
  group.remove(l.source.id);
  assert.equal(group.size(), 4);
  assert.deepEqual(group.entries().map((e) => e.order), [0, 1, 2, 3], 'order stays contiguous');

  assert.equal((await l.records.scan(COLLECTIONS.entities, null, 500)).items.length, entitiesBefore);
  assert.equal((await l.records.scan(COLLECTIONS.relationships, null, 500)).items.length, relsBefore);
  assert.equal((await l.records.scan(COLLECTIONS.knowledge, null, 500)).items.length, knowledgeBefore);
  await l.records.close();
});

test('configuration is addressable by id and input constraints are enforced', async () => {
  const l = await lab();
  assert.equal(configurationById('fragment-exploration-v1').id, 'fragment-exploration-v1');
  assert.throws(() => configurationById('does-not-exist'), /unknown research configuration/);

  const tiny = await l.service.importMaterial({
    bytes: encodeWav(synthesize(1, 8000, 1, 10)), filename: 'tiny.wav', agentId: l.artist.id });
  await assert.rejects(() => explore(l, 1000, 2, tiny.id), /below the configuration minimum/);
  await l.records.close();
});

test('exploration requires a pre-existing Research Intent', async () => {
  const l = await lab();
  await assert.rejects(() => l.service.runResearchConfiguration({
    materialId: l.source.id, configuration: FRAGMENT_EXPLORATION_V1,
    researchIntentId: 'ghost', baseSeed: 1, variationCount: 2, agentId: l.artist.id,
  }), /Research Intent that does not exist/);
  await l.records.close();
});
