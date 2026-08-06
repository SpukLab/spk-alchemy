import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IndexedDbRecordStore } from '../../src/adapters/indexeddb/record-store.ts';
import { IndexedDbContentStore } from '../../src/adapters/indexeddb/content-store.ts';
import { DataRegistry } from '../../src/registries/data-registry.ts';
import { registerAlchemyVocabulary, LIFECYCLE } from '../../src/domain/alchemy/vocabulary.ts';
import { AlchemyService } from '../../src/domain/alchemy/service.ts';
import { AlchemyQueries } from '../../src/query/queries.ts';
import { CURRENT_SCHEMA } from '../../src/migrations/index.ts';
import { FRAGMENT_EXPLORATION_V1 } from '../../src/domain/alchemy/research-configuration.ts';
import { selectVariation } from '../../src/domain/alchemy/exploration.ts';
import { synthesize, encodeWav } from '../../src/audio/wav.ts';
import { ANALYZER_V1 } from '../../src/audio/analyzer.ts';

/**
 * The entire artistic loop, running on IndexedDB instead of SQLite. Same core,
 * same domain service, same queries: only the adapters differ. This is what
 * "portable" has to mean in practice.
 */
let n = 0;
async function lab() {
  n += 1;
  const records = await IndexedDbRecordStore.open(`lab-records-${n}-${Date.now()}`, CURRENT_SCHEMA);
  await records.setSchemaVersion(CURRENT_SCHEMA.version);
  const content = await IndexedDbContentStore.open(`lab-content-${n}-${Date.now()}`);
  const registry = new DataRegistry();
  registerAlchemyVocabulary(registry);
  const service = new AlchemyService(records, content, registry);
  const queries = new AlchemyQueries(records, content);
  const artist = await service.registerAgent({ kind: 'human', name: 'artist', version: '1' });
  return { records, content, service, queries, artist };
}

test('the full capture-explore-retain loop runs on IndexedDB', async () => {
  const l = await lab();
  const analyzer = await l.service.registerAgent({
    kind: 'analyzer', name: 'physical-analyzer', version: '1.0.0' });

  const source = await l.service.importMaterial({
    bytes: encodeWav(synthesize(11, 8000, 1, 4000)),
    filename: 'captura.wav', agentId: l.artist.id });
  await l.service.analyzeMaterial(source.id, ANALYZER_V1, analyzer.id);

  const intent = await l.service.createResearchIntent({
    question: 'Exploración libre', agentId: l.artist.id });
  const set = await l.service.runResearchConfiguration({
    materialId: source.id, configuration: FRAGMENT_EXPLORATION_V1,
    researchIntentId: intent.id, baseSeed: 4242, variationCount: 8, agentId: l.artist.id });

  assert.equal(set.variations.length, 8);
  assert.equal(new Set(set.variations.map((v) => v.preview.contentHash)).size, 8);

  const inventoryBefore = (await l.queries.promotedMaterials(undefined, 50)).items.length;
  const keep = await l.service.retain(selectVariation(set, 2).preview, l.artist.id);
  assert.equal(keep.material.lifecycleState, LIFECYCLE.retained);
  assert.equal((await l.queries.promotedMaterials(undefined, 50)).items.length, inventoryBefore,
    'retained material is not yet in the Inventory');

  const promoted = await l.service.promote(keep.material.id, l.artist.id);
  assert.equal(promoted.material.id, keep.material.id, 'UUID preserved on IndexedDB too');
  assert.ok((await l.queries.promotedMaterials(undefined, 50)).items
    .some((m) => m.id === keep.material.id));

  // Genealogy resolves through IndexedDB adjacency reads.
  const ancestors = await l.queries.ancestors(keep.material.id);
  assert.deepEqual(ancestors.nodes.map((a) => a.id), [source.id]);

  // Provenance survived the round trip.
  const a = keep.material.attributes;
  assert.equal(a.configurationId, 'fragment-exploration-v1');
  assert.equal(a.seed, selectVariation(set, 2).seed);

  await l.records.close(); await l.content.close();
});

test('content is addressed by hash and never merged across imports', async () => {
  const l = await lab();
  const bytes = encodeWav(synthesize(3, 8000, 1, 1200));
  const a = await l.service.importMaterial({
    bytes, filename: 'a.wav', agentId: l.artist.id });
  const b = await l.service.importMaterial({
    bytes, filename: 'b.wav', agentId: l.artist.id });
  assert.notEqual(a.id, b.id, 'two occurrences, two identities');
  assert.equal(a.attributes.contentHash, b.attributes.contentHash);

  const groups = await l.queries.duplicateContentGroups();
  assert.deepEqual(groups.get(String(a.attributes.contentHash))?.sort(), [a.id, b.id].sort());
  assert.equal((await l.content.list()).length, 1, 'bytes stored once, addressed by hash');
  await l.records.close(); await l.content.close();
});

test('integrity audit works against IndexedDB stores', async () => {
  const l = await lab();
  const m = await l.service.importMaterial({
    bytes: encodeWav(synthesize(7, 8000, 1, 900)), filename: 'x.wav', agentId: l.artist.id });
  const clean = await l.queries.integrityAudit();
  assert.deepEqual(clean.materialsWithMissingContent, []);
  assert.deepEqual(clean.danglingRelationships, []);
  assert.deepEqual(clean.unreferencedContentBlobs, []);

  await l.content.remove(String(m.attributes.contentHash));
  const broken = await l.queries.integrityAudit();
  assert.deepEqual(broken.materialsWithMissingContent, [m.id], 'lost content is detected');
  await l.records.close(); await l.content.close();
});

test('rejected material keeps genealogy and stays out of the Inventory', async () => {
  const l = await lab();
  const source = await l.service.importMaterial({
    bytes: encodeWav(synthesize(21, 8000, 1, 2000)), filename: 's.wav', agentId: l.artist.id });
  const intent = await l.service.createResearchIntent({ question: 'q', agentId: l.artist.id });
  const set = await l.service.runResearchConfiguration({
    materialId: source.id, configuration: FRAGMENT_EXPLORATION_V1,
    researchIntentId: intent.id, baseSeed: 99, variationCount: 3, agentId: l.artist.id });
  const r = await l.service.retain(selectVariation(set, 0).preview, l.artist.id);
  await l.service.reject(r.material.id, l.artist.id, 'no sirve');

  const inv = await l.queries.promotedMaterials(undefined, 50);
  assert.ok(!inv.items.some((m) => m.id === r.material.id));
  const rejected = await l.queries.materialsByLifecycle(LIFECYCLE.rejected);
  assert.ok(rejected.items.some((m) => m.id === r.material.id));
  assert.equal((await l.queries.ancestors(r.material.id)).nodes.length, 1, 'genealogy intact');
  await l.records.close(); await l.content.close();
});
