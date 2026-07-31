import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteRecordStore } from '../../src/adapters/node-sqlite/record-store.ts';
import { FsContentStore } from '../../src/adapters/content-fs/content-store.ts';
import { DataRegistry } from '../../src/registries/data-registry.ts';
import { registerAlchemyVocabulary } from '../../src/domain/alchemy/vocabulary.ts';
import { AlchemyService } from '../../src/domain/alchemy/service.ts';
import { AlchemyQueries } from '../../src/query/queries.ts';
import { migrate, CURRENT_SCHEMA } from '../../src/migrations/index.ts';
import { synthesize, encodeWav, decodeWav } from '../../src/audio/wav.ts';
import { applyOperation } from '../../src/audio/experiment.ts';
import { contentHash } from '../../src/core/ids.ts';
import { COLLECTIONS } from '../../src/core/primitives.ts';

async function lab() {
  const dir = mkdtempSync(join(tmpdir(), 'spk-id-'));
  const records = new SqliteRecordStore(join(dir, 'store.sqlite'), CURRENT_SCHEMA);
  await migrate(records);
  const content = new FsContentStore(join(dir, 'content'));
  const data = new DataRegistry();
  registerAlchemyVocabulary(data);
  const service = new AlchemyService(records, content, data);
  const queries = new AlchemyQueries(records, content);
  const artist = await service.registerAgent({ kind: 'human', name: 'artist', version: '1' });
  return { records, content, service, queries, artist, dir };
}
const wav = (seed: number): Uint8Array => encodeWav(synthesize(seed, 8000, 1, 1500));

test('identical imported bytes create distinct UUIDs and one shared hash', async () => {
  const l = await lab();
  const bytes = wav(11);
  const a = await l.service.importMaterial({ bytes, filename: 'x.wav', agentId: l.artist.id });
  const b = await l.service.importMaterial({ bytes, filename: 'x-copy.wav', agentId: l.artist.id });
  assert.notEqual(a.id, b.id, 'entity identity is per-occurrence');
  assert.equal(a.attributes.contentHash, b.attributes.contentHash, 'content identity is shared');
  const groups = await l.queries.duplicateContentGroups();
  const group = groups.get(String(a.attributes.contentHash));
  assert.deepEqual(group?.sort(), [a.id, b.id].sort(), 'duplicates are reported, never merged');
  const both = await l.records.getMany(COLLECTIONS.entities, [a.id, b.id]);
  assert.ok(both.every((r) => r !== null), 'both histories survive independently');
  await l.records.close();
});

test('deterministic Experiment reproduces output bit for bit', async () => {
  const input = wav(21);
  const first = applyOperation('reverse', input, {});
  const second = applyOperation('reverse', input, {});
  assert.equal(contentHash(first), contentHash(second), 'identical hashes');
  assert.deepEqual(Buffer.from(first), Buffer.from(second), 'identical bytes');
  // Double reversal returns the original bytes exactly: the canonical WAV
  // header carries no nondeterministic metadata.
  assert.deepEqual(Buffer.from(applyOperation('reverse', first, {})), Buffer.from(input));
  // Parameterised operations are deterministic too.
  const g1 = applyOperation('gain', input, { gainNumerator: 1, gainDenominator: 2 });
  const g2 = applyOperation('gain', input, { gainNumerator: 1, gainDenominator: 2 });
  assert.equal(contentHash(g1), contentHash(g2));
  assert.notEqual(contentHash(g1), contentHash(input), 'different parameters, different output');
});

test('canonical WAV encoding carries no nondeterministic metadata', () => {
  const audio = synthesize(31, 8000, 2, 900);
  const bytes = encodeWav(audio);
  assert.equal(bytes.byteLength, 44 + audio.samples.length * 2, 'exactly one 44-byte header');
  const round = decodeWav(bytes);
  assert.equal(round.sampleRate, audio.sampleRate);
  assert.equal(round.channels, audio.channels);
  assert.deepEqual(Array.from(round.samples), Array.from(audio.samples));
  assert.deepEqual(Buffer.from(encodeWav(round)), Buffer.from(bytes), 'stable across re-encoding');
});

test('a persistent Material never references missing content', async () => {
  const l = await lab();
  const m = await l.service.importMaterial({
    bytes: wav(41), filename: 'a.wav', agentId: l.artist.id });
  assert.ok(await l.content.has(String(m.attributes.contentHash)));
  const audit = await l.queries.integrityAudit();
  assert.deepEqual(audit.materialsWithMissingContent, []);
  // Simulate content loss: the audit must detect it rather than fail silently.
  await l.content.remove(String(m.attributes.contentHash));
  const broken = await l.queries.integrityAudit();
  assert.deepEqual(broken.materialsWithMissingContent, [m.id]);
  await l.records.close();
});

test('an abandoned Retain leaves a collectable blob, never a dangling reference', async () => {
  const l = await lab();
  const source = await l.service.importMaterial({
    bytes: wav(51), filename: 'a.wav', agentId: l.artist.id });
  const intent = await l.service.createResearchIntent({ question: 'q', agentId: l.artist.id });
  const exp = await l.service.createExperiment({
    researchIntentId: intent.id, inputMaterialIds: [source.id],
    operation: 'reverse', agentId: l.artist.id });
  const preview = await l.service.runExperiment(exp.id);
  // Content-first ordering: write the bytes, then abandon before the batch.
  await l.content.put(preview.bytes);
  const audit = await l.queries.integrityAudit();
  assert.ok(audit.unreferencedContentBlobs.includes(preview.contentHash),
    'orphan blob is detectable for garbage collection');
  assert.deepEqual(audit.danglingRelationships, [], 'no record points at anything absent');
  assert.deepEqual(audit.orphanKnowledge, []);
  await l.records.close();
});

test('broken references and cycles are detected', async () => {
  const l = await lab();
  const a = await l.service.importMaterial({ bytes: wav(61), filename: 'a.wav', agentId: l.artist.id });
  const b = await l.service.importMaterial({ bytes: wav(62), filename: 'b.wav', agentId: l.artist.id });
  // Inject a relationship pointing at a nonexistent entity.
  await l.records.commit([{ op: 'put', collection: COLLECTIONS.relationships, record: {
    id: 'broken-1', type: 'derived_from', source: a.id, target: 'ghost',
    agentId: l.artist.id, evidence: [], metadata: {}, schemaVersion: 1, createdAt: 1 } }]);
  const audit = await l.queries.integrityAudit();
  assert.deepEqual(audit.danglingRelationships, ['broken-1']);

  // Inject a cycle a -> b -> a and confirm traversal terminates.
  await l.records.commit([
    { op: 'put', collection: COLLECTIONS.relationships, record: {
      id: 'cyc-1', type: 'derived_from', source: a.id, target: b.id,
      agentId: l.artist.id, evidence: [], metadata: {}, schemaVersion: 1, createdAt: 2 } },
    { op: 'put', collection: COLLECTIONS.relationships, record: {
      id: 'cyc-2', type: 'derived_from', source: b.id, target: a.id,
      agentId: l.artist.id, evidence: [], metadata: {}, schemaVersion: 1, createdAt: 3 } },
  ]);
  const anc = await l.queries.ancestors(a.id);
  assert.ok(anc.cyclesDetected.length > 0, 'cycle reported');
  assert.ok(anc.nodes.length <= 3, 'traversal terminates instead of looping');
  await l.records.close();
});

test('genealogy survives several derivation generations', async () => {
  const l = await lab();
  const root = await l.service.importMaterial({
    bytes: wav(71), filename: 'root.wav', agentId: l.artist.id });
  const intent = await l.service.createResearchIntent({ question: 'depth', agentId: l.artist.id });
  let current = root.id;
  const chain: string[] = [];
  for (let i = 0; i < 4; i++) {
    const exp = await l.service.createExperiment({
      researchIntentId: intent.id, inputMaterialIds: [current],
      operation: 'reverse', agentId: l.artist.id });
    const preview = await l.service.runExperiment(exp.id);
    const r = await l.service.retain(preview, l.artist.id);
    await l.service.promote(r.material.id, l.artist.id);
    current = r.material.id; chain.push(current);
  }
  const anc = await l.queries.ancestors(current);
  assert.equal(anc.nodes.length, 4, 'four ancestors back to the root');
  assert.equal(anc.nodes.at(-1)!.id, root.id);
  assert.deepEqual(anc.nodes.map((n) => n.depth), [1, 2, 3, 4], 'depth is recorded per generation');
  const desc = await l.queries.descendants(root.id);
  assert.deepEqual(desc.nodes.map((n) => n.id).sort(), [...chain].sort());
  const shallow = await l.queries.ancestors(current, 2);
  assert.equal(shallow.nodes.length, 2, 'depth limit honoured');
  await l.records.close();
});

test('migrations rebuild the store deterministically from zero', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spk-mig-'));
  const path = join(dir, 'store.sqlite');
  const first = new SqliteRecordStore(path, CURRENT_SCHEMA);
  assert.equal(await first.schemaVersion(), 0, 'empty store starts at version 0');
  assert.equal(await migrate(first), 1);
  assert.equal(await migrate(first), 1, 'migration is idempotent');
  await first.close();
  await rm(path, { force: true });
  const rebuilt = new SqliteRecordStore(path, CURRENT_SCHEMA);
  assert.equal(await migrate(rebuilt), 1, 'rebuild from an empty store reaches the same version');
  await rebuilt.close();
});
