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
import { AlchemyQueries } from '../../src/query/queries.ts';
import { migrate, CURRENT_SCHEMA } from '../../src/migrations/index.ts';
import { synthesize, encodeWav } from '../../src/audio/wav.ts';
import { FRAGMENT_EXPLORATION_V1_2 } from '../../src/domain/alchemy/research-configuration.ts';
import { selectVariation } from '../../src/domain/alchemy/exploration.ts';
import {
  LINEAGE_PALETTE, MULTI_ROOT_COLOR, resolveLineageRoot, paletteIndexForRoot,
  lineageColorForRoot, lineageColorForMaterial,
} from '../../src/domain/alchemy/lineage.ts';

async function lab() {
  const dir = mkdtempSync(join(tmpdir(), 'spk-lineage-'));
  const records = new SqliteRecordStore(join(dir, 'store.sqlite'), CURRENT_SCHEMA);
  await migrate(records);
  const content = new FsContentStore(join(dir, 'content'));
  const registry = new DataRegistry();
  registerAlchemyVocabulary(registry);
  const service = new AlchemyService(records, content, registry);
  const families = new FamilyService(records, content, registry);
  const queries = new AlchemyQueries(records, content);
  const artist = await service.registerAgent({ kind: 'human', name: 'artist', version: '1' });
  return { records, content, service, families, queries, artist };
}

const wav = (seed: number) => encodeWav(synthesize(seed, 8000, 1, 3000));

test('13+14. one root resolves deterministically to one palette color; re-render matches', async () => {
  const l = await lab();
  const root = await l.service.importMaterial({ bytes: wav(1), filename: 'a.wav', agentId: l.artist.id });
  const color1 = await lineageColorForMaterial(root.id, l.queries);
  const color2 = await lineageColorForMaterial(root.id, l.queries);
  assert.equal(color1, color2);
  assert.ok(LINEAGE_PALETTE.includes(color1));
  await l.records.close();
});

test('15. resolves the same color after a store reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spk-lineage-reopen-'));
  const path = join(dir, 'store.sqlite');
  const records1 = new SqliteRecordStore(path, CURRENT_SCHEMA);
  await migrate(records1);
  const content1 = new FsContentStore(join(dir, 'content'));
  const registry1 = new DataRegistry();
  registerAlchemyVocabulary(registry1);
  const service1 = new AlchemyService(records1, content1, registry1);
  const artist1 = await service1.registerAgent({ kind: 'human', name: 'artist', version: '1' });
  const root = await service1.importMaterial({ bytes: wav(2), filename: 'a.wav', agentId: artist1.id });
  const before = await lineageColorForMaterial(root.id, new AlchemyQueries(records1, content1));
  await records1.close();

  const records2 = new SqliteRecordStore(path, CURRENT_SCHEMA);
  const content2 = new FsContentStore(join(dir, 'content'));
  const after = await lineageColorForMaterial(root.id, new AlchemyQueries(records2, content2));
  assert.equal(after, before);
  await records2.close();
});

async function deriveOnce(l: Awaited<ReturnType<typeof lab>>, sourceId: string, seedOffset: number) {
  const intent = await l.service.createResearchIntent({ question: 'q', agentId: l.artist.id });
  const set = await l.service.runResearchConfiguration({
    materialId: sourceId, configuration: FRAGMENT_EXPLORATION_V1_2,
    researchIntentId: intent.id, baseSeed: 1000 + seedOffset, variationCount: 2, agentId: l.artist.id });
  const r = await l.service.retain(selectVariation(set, 0).preview, l.artist.id);
  return r.material;
}

test('16. a direct derived child inherits the root lineage color', async () => {
  const l = await lab();
  const root = await l.service.importMaterial({ bytes: wav(3), filename: 'a.wav', agentId: l.artist.id });
  const child = await deriveOnce(l, root.id, 1);
  const rootColor = await lineageColorForMaterial(root.id, l.queries);
  const childColor = await lineageColorForMaterial(child.id, l.queries);
  assert.equal(childColor, rootColor);
  await l.records.close();
});

test('17. a second-generation descendant inherits the same root color', async () => {
  const l = await lab();
  const root = await l.service.importMaterial({ bytes: wav(4), filename: 'a.wav', agentId: l.artist.id });
  const child = await deriveOnce(l, root.id, 1);
  await l.service.promote(child.id, l.artist.id);
  const grandchild = await deriveOnce(l, child.id, 2);
  const rootColor = await lineageColorForMaterial(root.id, l.queries);
  const grandchildColor = await lineageColorForMaterial(grandchild.id, l.queries);
  assert.equal(grandchildColor, rootColor);
  const rootResolved = await resolveLineageRoot(grandchild.id, l.queries);
  assert.equal(rootResolved.rootId, root.id, 'the resolved root is the original import, not the intermediate');
  await l.records.close();
});

test('18. two unrelated roots resolve to distinguishable colors for these fixtures', () => {
  // Material ids are random UUIDs, so two arbitrary imports could coincide on
  // the same 1-of-10 palette slot by chance -- not a defect, just a property
  // of the small deliberately-limited palette. This test uses fixed reference
  // fixtures (verified in advance to land on different slots) to demonstrate
  // distinguishability itself, per "for the chosen reference fixtures."
  const colorA = lineageColorForRoot('fixture-root-alpha');
  const colorB = lineageColorForRoot('fixture-root-beta');
  assert.notEqual(colorA, colorB);
});

test('19+20+21+22. lineage color is independent of lifecycle transitions', async () => {
  const l = await lab();
  const root = await l.service.importMaterial({ bytes: wav(7), filename: 'a.wav', agentId: l.artist.id });
  const before = await lineageColorForMaterial(root.id, l.queries);

  const child = await deriveOnce(l, root.id, 1);
  const childColorRetained = await lineageColorForMaterial(child.id, l.queries); // just retained, not yet promoted
  await l.service.promote(child.id, l.artist.id);
  const childColorPromoted = await lineageColorForMaterial(child.id, l.queries);
  assert.equal(childColorRetained, childColorPromoted, 'Promote does not change lineage color');

  const rejectedChild = await deriveOnce(l, root.id, 2);
  const beforeReject = await lineageColorForMaterial(rejectedChild.id, l.queries);
  await l.service.reject(rejectedChild.id, l.artist.id, 'no sirve');
  const afterReject = await lineageColorForMaterial(rejectedChild.id, l.queries);
  assert.equal(beforeReject, afterReject, 'Reject does not change lineage color derivation');

  const afterAll = await lineageColorForMaterial(root.id, l.queries);
  assert.equal(afterAll, before, 'the root itself is unaffected by descendants changing state');
  await l.records.close();
});

test('23. Family membership does not alter lineage color', async () => {
  const l = await lab();
  const root = await l.service.importMaterial({ bytes: wav(8), filename: 'a.wav', agentId: l.artist.id });
  const before = await lineageColorForMaterial(root.id, l.queries);
  await l.families.createFamily({ name: 'F', materialIds: [root.id], agentId: l.artist.id });
  const after = await lineageColorForMaterial(root.id, l.queries);
  assert.equal(before, after);
  await l.records.close();
});

test('24. DNA Pack publication does not alter lineage color', async () => {
  const l = await lab();
  const root = await l.service.importMaterial({ bytes: wav(9), filename: 'a.wav', agentId: l.artist.id });
  const before = await lineageColorForMaterial(root.id, l.queries);
  const family = await l.families.createFamily({ name: 'F', materialIds: [root.id], agentId: l.artist.id });
  await l.families.publish(family.id, l.artist.id);
  const after = await lineageColorForMaterial(root.id, l.queries);
  assert.equal(before, after);
  await l.records.close();
});

test('25. multi-root fallback is deterministic', async () => {
  // Simulate a multi-root Material by injecting two derived_from edges to two
  // independent imported roots — not producible by the current DSP (which
  // only ever derives from one source), but the fallback must still hold.
  const l = await lab();
  const a = await l.service.importMaterial({ bytes: wav(10), filename: 'a.wav', agentId: l.artist.id });
  const b = await l.service.importMaterial({ bytes: wav(11), filename: 'b.wav', agentId: l.artist.id });
  const merged = await l.service.importMaterial({ bytes: wav(12), filename: 'm.wav', agentId: l.artist.id });
  const { COLLECTIONS } = await import('../../src/core/primitives.ts');
  await l.records.commit([
    { op: 'put', collection: COLLECTIONS.relationships, record: {
      id: 'inj-1', type: 'derived_from', source: merged.id, target: a.id,
      agentId: l.artist.id, evidence: [], metadata: {}, schemaVersion: 1, createdAt: 1 } },
    { op: 'put', collection: COLLECTIONS.relationships, record: {
      id: 'inj-2', type: 'derived_from', source: merged.id, target: b.id,
      agentId: l.artist.id, evidence: [], metadata: {}, schemaVersion: 1, createdAt: 2 } },
  ]);
  const resolved1 = await resolveLineageRoot(merged.id, l.queries);
  const resolved2 = await resolveLineageRoot(merged.id, l.queries);
  assert.equal(resolved1.multiRoot, true);
  assert.equal(resolved1.rootId, resolved2.rootId, 'the fallback root choice is deterministic across calls');
  const color = await lineageColorForMaterial(merged.id, l.queries);
  assert.equal(color, MULTI_ROOT_COLOR, 'multi-root Materials use the neutral fallback marker');
  await l.records.close();
});

test('26+27. no canonical primitive or persistence field was introduced', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile('src/domain/alchemy/lineage.ts', 'utf8');
  assert.ok(!/COLLECTIONS\.|\.commit\(|RecordStore/.test(source),
    'lineage.ts must never write to persistence — color is derived, never stored');
  const schemaSource = await readFile('src/persistence/schema.ts', 'utf8');
  assert.ok(!/lineage|color/i.test(schemaSource), 'no lineage/color field was added to any index or schema');
});

test('28. lineage module has no Node built-in dependency', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile('src/domain/alchemy/lineage.ts', 'utf8');
  assert.ok(!/from ['"]node:/.test(source));
});

test('paletteIndexForRoot is a pure function, independent of any store', () => {
  const a = paletteIndexForRoot('11111111-1111-1111-1111-111111111111');
  const b = paletteIndexForRoot('22222222-2222-2222-2222-222222222222');
  const aAgain = paletteIndexForRoot('11111111-1111-1111-1111-111111111111');
  assert.equal(a, aAgain);
  assert.ok(a >= 0 && a < LINEAGE_PALETTE.length);
  assert.ok(b >= 0 && b < LINEAGE_PALETTE.length);
  assert.equal(lineageColorForRoot('11111111-1111-1111-1111-111111111111'), LINEAGE_PALETTE[a]);
});
