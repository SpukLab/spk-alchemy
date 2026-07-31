import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteRecordStore } from '../../src/adapters/node-sqlite/record-store.ts';
import { FsContentStore } from '../../src/adapters/content-fs/content-store.ts';
import { DataRegistry } from '../../src/registries/data-registry.ts';
import { ViewRegistry } from '../../src/registries/view-registry.ts';
import { registerAlchemyVocabulary, LIFECYCLE, KNOWLEDGE_KIND } from '../../src/domain/alchemy/vocabulary.ts';
import { AlchemyService } from '../../src/domain/alchemy/service.ts';
import { AlchemyQueries } from '../../src/query/queries.ts';
import { migrate, CURRENT_SCHEMA } from '../../src/migrations/index.ts';
import { synthesize, encodeWav } from '../../src/audio/wav.ts';
import { ANALYZER_V1, ANALYZER_V2 } from '../../src/audio/analyzer.ts';
import { COLLECTIONS } from '../../src/core/primitives.ts';

async function lab(withView = true) {
  const dir = mkdtempSync(join(tmpdir(), 'spk-lab-'));
  const records = new SqliteRecordStore(join(dir, 'store.sqlite'), CURRENT_SCHEMA);
  await migrate(records);
  const content = new FsContentStore(join(dir, 'content'));
  const data = new DataRegistry();
  const view = new ViewRegistry();
  registerAlchemyVocabulary(data, withView ? view : undefined);
  const service = new AlchemyService(records, content, data);
  const queries = new AlchemyQueries(records, content);
  const artist = await service.registerAgent({ kind: 'human', name: 'artist', version: '1' });
  return { records, content, data, view, service, queries, artist, dir };
}

const wav = (seed: number): Uint8Array => encodeWav(synthesize(seed, 8000, 1, 1200));

async function derived(l: Awaited<ReturnType<typeof lab>>) {
  const source = await l.service.importMaterial({
    bytes: wav(1), filename: 's.wav', agentId: l.artist.id });
  const intent = await l.service.createResearchIntent({
    question: 'discover a bass that breathes', agentId: l.artist.id });
  const experiment = await l.service.createExperiment({
    researchIntentId: intent.id, inputMaterialIds: [source.id],
    operation: 'reverse', agentId: l.artist.id });
  const preview = await l.service.runExperiment(experiment.id);
  return { source, intent, experiment, preview };
}

test('a Preview does not persist automatically', async () => {
  const l = await lab();
  const { preview } = await derived(l);
  const before = await l.records.scan(COLLECTIONS.entities, null, 100);
  const materialIds = before.items.filter((e) => (e as { role?: string }).role === 'material');
  assert.equal(materialIds.length, 1, 'only the imported source exists; the Preview is runtime');
  assert.ok(preview.contentHash.length === 64);
  await l.records.close();
});

test('Discard leaves no persistent record', async () => {
  const l = await lab();
  const { preview } = await derived(l);
  const beforeT = (await l.records.scan(COLLECTIONS.transitions, null, 100)).items.length;
  l.service.discardPreview(preview);
  const afterT = (await l.records.scan(COLLECTIONS.transitions, null, 100)).items.length;
  assert.equal(afterT, beforeT, 'discard writes no Transition');
  const materials = (await l.records.scan(COLLECTIONS.entities, null, 100)).items
    .filter((e) => (e as { role?: string }).role === 'material');
  assert.equal(materials.length, 1);
  await l.records.close();
});

test('Retain creates exactly one Material Entity with complete genealogy', async () => {
  const l = await lab();
  const { source, experiment, intent, preview } = await derived(l);
  const r = await l.service.retain(preview, l.artist.id, 'worth memory');
  assert.equal(r.created, true);
  assert.equal(r.material.lifecycleState, LIFECYCLE.retained);

  const materials = (await l.records.scan(COLLECTIONS.entities, null, 100)).items
    .filter((e) => (e as { role?: string }).role === 'material');
  assert.equal(materials.length, 2, 'source + exactly one retained material');

  const anc = await l.queries.ancestors(r.material.id);
  assert.deepEqual(anc.nodes.map((n) => n.id), [source.id], 'genealogy reaches the source');

  const io = await l.queries.experimentInputsOutputs(experiment.id);
  assert.deepEqual(io.inputs.map((i) => i.id), [source.id]);
  assert.deepEqual(io.outputs.map((o) => o.id), [r.material.id]);

  const experiments = await l.queries.experimentsForIntent(intent.id);
  assert.deepEqual(experiments.map((e) => e.id), [experiment.id]);

  const t = (await l.queries.transitionsFor(r.material.id))[0]!;
  assert.equal(t.kind, 'retain');
  assert.equal(t.agentId, l.artist.id);
  assert.equal(t.context.researchIntentId, intent.id, 'Retain records why the work existed');
  await l.records.close();
});

test('retained material stays outside the default Inventory', async () => {
  const l = await lab();
  const { preview } = await derived(l);
  const r = await l.service.retain(preview, l.artist.id);
  const inv = await l.queries.promotedMaterials();
  assert.ok(!inv.items.some((m) => m.id === r.material.id));
  const retained = await l.queries.materialsByLifecycle(LIFECYCLE.retained);
  assert.ok(retained.items.some((m) => m.id === r.material.id));
  await l.records.close();
});

test('Promote and Reject preserve the UUID and create no second Entity', async () => {
  const l = await lab();
  const { preview } = await derived(l);
  const r = await l.service.retain(preview, l.artist.id);
  const countBefore = (await l.records.scan(COLLECTIONS.entities, null, 100)).items.length;

  const p = await l.service.promote(r.material.id, l.artist.id);
  assert.equal(p.material.id, r.material.id, 'promotion preserves identity');
  assert.equal(p.material.lifecycleState, LIFECYCLE.promoted);

  const j = await l.service.reject(r.material.id, l.artist.id, 'reconsidered');
  assert.equal(j.material.id, r.material.id, 'rejection preserves identity');
  assert.equal(j.material.lifecycleState, LIFECYCLE.rejected);

  const countAfter = (await l.records.scan(COLLECTIONS.entities, null, 100)).items.length;
  assert.equal(countAfter, countBefore, 'no replacement Material identity was created');

  // Rejected material keeps its full genealogy and stays out of the Inventory.
  const anc = await l.queries.ancestors(r.material.id);
  assert.equal(anc.nodes.length, 1);
  const inv = await l.queries.promotedMaterials();
  assert.ok(!inv.items.some((m) => m.id === r.material.id));
  await l.records.close();
});

test('lifecycle transitions and Retain are idempotent', async () => {
  const l = await lab();
  const { preview } = await derived(l);
  const first = await l.service.retain(preview, l.artist.id);
  const again = await l.service.retain(preview, l.artist.id);
  assert.equal(again.created, false, 'a retried Retain is a no-op');
  assert.equal(again.material.id, first.material.id);

  await l.service.promote(first.material.id, l.artist.id);
  const repeat = await l.service.promote(first.material.id, l.artist.id);
  assert.equal(repeat.changed, false, 'completed transition applied again is an explicit no-op');
  const transitions = await l.queries.transitionsFor(first.material.id);
  assert.equal(transitions.filter((t) => t.kind === 'promote').length, 1, 'no duplicated Transition');
  await l.records.close();
});

test('Research Intent is mandatory and cannot be inferred afterwards', async () => {
  const l = await lab();
  const source = await l.service.importMaterial({
    bytes: wav(2), filename: 'a.wav', agentId: l.artist.id });
  await assert.rejects(() => l.service.createExperiment({
    researchIntentId: '', inputMaterialIds: [source.id],
    operation: 'reverse', agentId: l.artist.id }), /Research Intent/);
  await assert.rejects(() => l.service.createExperiment({
    researchIntentId: 'does-not-exist', inputMaterialIds: [source.id],
    operation: 'reverse', agentId: l.artist.id }), /does not exist/);
  await l.records.close();
});

test('Observation provenance cannot be omitted', async () => {
  const l = await lab();
  const source = await l.service.importMaterial({
    bytes: wav(3), filename: 'a.wav', agentId: l.artist.id });
  await assert.rejects(
    () => l.service.analyzeMaterial(source.id, ANALYZER_V1, 'no-such-agent'), /not found/);
  const analyzer = await l.service.registerAgent({
    kind: 'analyzer', name: 'physical-analyzer', version: '1.0.0' });
  const obs = await l.service.analyzeMaterial(source.id, ANALYZER_V1, analyzer.id);
  assert.equal(obs.agentId, analyzer.id);
  assert.equal(obs.agentVersion, '1.0.0');
  assert.equal(obs.payload.sourceContentHash, source.attributes.contentHash);
  await l.records.close();
});

test('analyzer versions coexist without mutation or deletion', async () => {
  const l = await lab();
  const source = await l.service.importMaterial({
    bytes: wav(4), filename: 'a.wav', agentId: l.artist.id });
  const a1 = await l.service.registerAgent({ kind: 'analyzer', name: 'physical-analyzer', version: '1.0.0' });
  const a2 = await l.service.registerAgent({ kind: 'analyzer', name: 'physical-analyzer', version: '2.0.0' });
  const o1 = await l.service.analyzeMaterial(source.id, ANALYZER_V1, a1.id);
  const o2 = await l.service.analyzeMaterial(source.id, ANALYZER_V2, a2.id);
  assert.notEqual(o1.id, o2.id);
  const grouped = await l.queries.observationsForMaterial(source.id);
  assert.equal(grouped.size, 2, 'both versions retained, grouped by agent and version');
  const diff = await l.queries.compareAnalyzerVersions(source.id, '1.0.0', '2.0.0');
  const centroid = diff.find((d) => d.metric === 'spectralCentroidHz');
  assert.ok(centroid && centroid.a === null && typeof centroid.b === 'number',
    'v2 adds a metric that v1 never had, without rewriting v1');
  const shared = diff.find((d) => d.metric === 'rms');
  assert.equal(shared?.equal, true, 'shared metrics agree across versions');
  await l.records.close();
});

test('Canon is a query over Knowledge, not a separate store', async () => {
  const l = await lab();
  const source = await l.service.importMaterial({
    bytes: wav(5), filename: 'a.wav', agentId: l.artist.id });
  await l.service.assertKnowledge({
    subject: source.id, kind: KNOWLEDGE_KIND.curatedConclusion, stage: 'canon',
    payload: { note: 'accepted' }, agentId: l.artist.id, confidence: 0.8 });
  await l.service.assertKnowledge({
    subject: source.id, kind: KNOWLEDGE_KIND.curatedConclusion, stage: 'hypothesis',
    payload: { note: 'maybe' }, agentId: l.artist.id });
  const canon = await l.queries.canonKnowledgeForSubject(source.id);
  assert.equal(canon.length, 1, 'canon is derived by epistemic stage');
  assert.equal(canon[0]!.stage, 'canon');
  // Everything lives in one collection: there is no Canon store to consult.
  const all = await l.records.scan(COLLECTIONS.knowledge, null, 100);
  assert.equal(all.items.length, 2);
  await l.records.close();
});

test('canonical data remains valid without the View Registry', async () => {
  const l = await lab(false);
  const source = await l.service.importMaterial({
    bytes: wav(6), filename: 'a.wav', agentId: l.artist.id });
  assert.equal(source.lifecycleState, LIFECYCLE.promoted);
  assert.equal(l.view.view('audio-material'), null, 'no presentation registered');
  assert.equal(l.view.label('audio-material'), 'audio-material', 'absence is not an error');
  const inv = await l.queries.promotedMaterials();
  assert.equal(inv.items.length, 1, 'queries work with an empty View Registry');
  await l.records.close();
});
