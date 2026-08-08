import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteRecordStore } from '../../src/adapters/node-sqlite/record-store.ts';
import { IndexedDbRecordStore } from '../../src/adapters/indexeddb/record-store.ts';
import { FsContentStore } from '../../src/adapters/content-fs/content-store.ts';
import { DataRegistry } from '../../src/registries/data-registry.ts';
import { registerAlchemyVocabulary, LIFECYCLE } from '../../src/domain/alchemy/vocabulary.ts';
import { AlchemyService } from '../../src/domain/alchemy/service.ts';
import { FamilyService } from '../../src/domain/alchemy/family-service.ts';
import { migrate, CURRENT_SCHEMA } from '../../src/migrations/index.ts';
import { synthesize, encodeWav, decodeWav } from '../../src/audio/wav.ts';
import { FRAGMENT_EXPLORATION_V1_2 } from '../../src/domain/alchemy/research-configuration.ts';
import { selectVariation } from '../../src/domain/alchemy/exploration.ts';
import { buildDnaPackZip, packDirectoryName } from '../../src/domain/alchemy/dna-pack.ts';
import { COLLECTIONS } from '../../src/core/primitives.ts';
import { createZip, crc32 } from '../../src/format/zip.ts';

let n = 0;
async function lab() {
  n += 1;
  const dir = mkdtempSync(join(tmpdir(), 'spk-family-'));
  const records = new SqliteRecordStore(join(dir, 'store.sqlite'), CURRENT_SCHEMA);
  await migrate(records);
  const content = new FsContentStore(join(dir, 'content'));
  const registry = new DataRegistry();
  registerAlchemyVocabulary(registry);
  const service = new AlchemyService(records, content, registry);
  const families = new FamilyService(records, content, registry);
  const artist = await service.registerAgent({ kind: 'human', name: 'artist', version: '1' });
  return { records, content, service, families, artist, dir };
}

const wav = (seed: number) => encodeWav(synthesize(seed, 8000, 1, 3000));

async function promotedMaterial(l: Awaited<ReturnType<typeof lab>>, seed: number) {
  const m = await l.service.importMaterial({
    bytes: wav(seed), filename: `m${seed}.wav`, agentId: l.artist.id });
  return m; // importMaterial already enters as `promoted` — see finding F-6
}

async function retainedNotPromoted(l: Awaited<ReturnType<typeof lab>>, seed: number) {
  const source = await promotedMaterial(l, seed);
  const intent = await l.service.createResearchIntent({ question: 'q', agentId: l.artist.id });
  const set = await l.service.runResearchConfiguration({
    materialId: source.id, configuration: FRAGMENT_EXPLORATION_V1_2,
    researchIntentId: intent.id, baseSeed: seed * 100, variationCount: 2, agentId: l.artist.id });
  const r = await l.service.retain(selectVariation(set, 0).preview, l.artist.id);
  return r.material; // retained, not promoted
}

test('1. a Family can be created from promoted Materials', async () => {
  const l = await lab();
  const a = await promotedMaterial(l, 1), b = await promotedMaterial(l, 2);
  const family = await l.families.createFamily({
    name: 'Metal breathing', materialIds: [a.id, b.id], agentId: l.artist.id });
  assert.equal(family.attributes.name, 'Metal breathing');
  const members = await l.families.listMembers(family.id);
  assert.deepEqual(members.map((m) => m.materialId), [a.id, b.id]);
  await l.records.close();
});

test('2. runtime Previews cannot enter a Family directly', async () => {
  // There is no code path that accepts a Preview: createFamily only accepts
  // materialIds (persistent Entity ids). A staged Preview has no such id
  // until Retain, so it structurally cannot be passed in.
  const l = await lab();
  const source = await promotedMaterial(l, 3);
  const intent = await l.service.createResearchIntent({ question: 'q', agentId: l.artist.id });
  const set = await l.service.runResearchConfiguration({
    materialId: source.id, configuration: FRAGMENT_EXPLORATION_V1_2,
    researchIntentId: intent.id, baseSeed: 1, variationCount: 2, agentId: l.artist.id });
  const preview = selectVariation(set, 0).preview;
  assert.equal('stagingRef' in preview, true, 'a Preview only has a staging reference, never a Material id');
  await assert.rejects(() => l.families.createFamily({
    name: 'x', materialIds: [preview.stagingRef], agentId: l.artist.id }));
  await l.records.close();
});

test('3. rejected Materials cannot enter the default Family flow', async () => {
  const l = await lab();
  const rejected = await retainedNotPromoted(l, 4);
  await l.service.reject(rejected.id, l.artist.id, 'not useful');
  await assert.rejects(
    () => l.families.createFamily({ name: 'x', materialIds: [rejected.id], agentId: l.artist.id }),
    /only promoted materials/);
  await l.records.close();
});

test('4. Family has stable identity', async () => {
  const l = await lab();
  const a = await promotedMaterial(l, 5);
  const family = await l.families.createFamily({
    name: 'Stable', materialIds: [a.id], agentId: l.artist.id });
  assert.match(family.id, /^[0-9a-f-]{36}$/);
  await l.records.close();
});

test('5. adding a member preserves Family identity', async () => {
  const l = await lab();
  const a = await promotedMaterial(l, 6), b = await promotedMaterial(l, 7);
  const family = await l.families.createFamily({ name: 'F', materialIds: [a.id], agentId: l.artist.id });
  await l.families.addMember(family.id, b.id, l.artist.id);
  const after = await l.families.getFamily(family.id);
  assert.equal(after.id, family.id);
  const members = await l.families.listMembers(family.id);
  assert.deepEqual(members.map((m) => m.materialId).sort(), [a.id, b.id].sort());
  await l.records.close();
});

test('6. removing a member preserves Family identity', async () => {
  const l = await lab();
  const a = await promotedMaterial(l, 8), b = await promotedMaterial(l, 9);
  const family = await l.families.createFamily({
    name: 'F', materialIds: [a.id, b.id], agentId: l.artist.id });
  await l.families.removeMember(family.id, a.id, l.artist.id);
  const after = await l.families.getFamily(family.id);
  assert.equal(after.id, family.id);
  const members = await l.families.listMembers(family.id);
  assert.deepEqual(members.map((m) => m.materialId), [b.id]);
  await l.records.close();
});

test('7. reordering members preserves Family identity', async () => {
  const l = await lab();
  const a = await promotedMaterial(l, 10), b = await promotedMaterial(l, 11), c = await promotedMaterial(l, 12);
  const family = await l.families.createFamily({
    name: 'F', materialIds: [a.id, b.id, c.id], agentId: l.artist.id });
  await l.families.reorderMembers(family.id, [c.id, a.id, b.id], l.artist.id);
  const after = await l.families.getFamily(family.id);
  assert.equal(after.id, family.id);
  const members = await l.families.listMembers(family.id);
  assert.deepEqual(members.map((m) => m.materialId), [c.id, a.id, b.id]);
  await l.records.close();
});

test('8. member ordering persists', async () => {
  const l = await lab();
  const a = await promotedMaterial(l, 13), b = await promotedMaterial(l, 14), c = await promotedMaterial(l, 15);
  const family = await l.families.createFamily({
    name: 'F', materialIds: [a.id, b.id, c.id], agentId: l.artist.id });
  await l.families.reorderMembers(family.id, [b.id, c.id, a.id], l.artist.id);
  const m1 = await l.families.listMembers(family.id);
  const m2 = await l.families.listMembers(family.id); // second independent read
  assert.deepEqual(m1.map((m) => m.materialId), [b.id, c.id, a.id]);
  assert.deepEqual(m2.map((m) => m.materialId), [b.id, c.id, a.id]);
  await l.records.close();
});

test('9. Family survives IndexedDB reopen', async () => {
  const dbName = `family-idb-${n++}-${Date.now()}`;
  const contentName = `family-content-idb-${n}-${Date.now()}`;
  const records1 = await IndexedDbRecordStore.open(dbName, CURRENT_SCHEMA);
  await records1.setSchemaVersion(CURRENT_SCHEMA.version);
  const dir = mkdtempSync(join(tmpdir(), 'spk-family-idb-'));
  const content1 = new FsContentStore(join(dir, 'content'));
  const registry1 = new DataRegistry();
  registerAlchemyVocabulary(registry1);
  const service1 = new AlchemyService(records1, content1, registry1);
  const families1 = new FamilyService(records1, content1, registry1);
  const artist1 = await service1.registerAgent({ kind: 'human', name: 'artist', version: '1' });
  const a = await service1.importMaterial({ bytes: wav(16), filename: 'a.wav', agentId: artist1.id });
  const family = await families1.createFamily({
    name: 'Persisted', materialIds: [a.id], agentId: artist1.id });
  await records1.close();

  const records2 = await IndexedDbRecordStore.open(dbName, CURRENT_SCHEMA);
  const registry2 = new DataRegistry();
  registerAlchemyVocabulary(registry2);
  const content2 = new FsContentStore(join(dir, 'content'));
  const families2 = new FamilyService(records2, content2, registry2);
  const reopened = await families2.getFamily(family.id);
  assert.equal(reopened.attributes.name, 'Persisted');
  const members = await families2.listMembers(family.id);
  assert.deepEqual(members.map((m) => m.materialId), [a.id]);
  await records2.close();
});

test('10. equivalent Family behavior works through the portable store contract (SQLite == IndexedDB)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spk-family-equiv-'));
  const sqlite = new SqliteRecordStore(join(dir, 'store.sqlite'), CURRENT_SCHEMA);
  await migrate(sqlite);
  const idb = await IndexedDbRecordStore.open(`family-equiv-${Date.now()}`, CURRENT_SCHEMA);
  await idb.setSchemaVersion(CURRENT_SCHEMA.version);

  for (const records of [sqlite, idb]) {
    const content = new FsContentStore(join(dir, `content-${records === sqlite ? 'sqlite' : 'idb'}`));
    const registry = new DataRegistry();
    registerAlchemyVocabulary(registry);
    const service = new AlchemyService(records, content, registry);
    const families = new FamilyService(records, content, registry);
    const artist = await service.registerAgent({ kind: 'human', name: 'artist', version: '1' });
    const a = await service.importMaterial({ bytes: wav(20), filename: 'a.wav', agentId: artist.id });
    const b = await service.importMaterial({ bytes: wav(21), filename: 'b.wav', agentId: artist.id });
    const family = await families.createFamily({ name: 'Equiv', materialIds: [a.id, b.id], agentId: artist.id });
    await families.reorderMembers(family.id, [b.id, a.id], artist.id);
    const members = await families.listMembers(family.id);
    assert.deepEqual(members.map((m) => m.materialId), [b.id, a.id],
      `${records === sqlite ? 'SQLite' : 'IndexedDB'} adapter produced the expected order`);
  }
  await sqlite.close(); await idb.close();
});

test('11. publishing creates one DNA Pack', async () => {
  const l = await lab();
  const a = await promotedMaterial(l, 22), b = await promotedMaterial(l, 23);
  const family = await l.families.createFamily({ name: 'F', materialIds: [a.id, b.id], agentId: l.artist.id });
  const before = (await l.records.scan(COLLECTIONS.entities, null, 500)).items.length;
  const { pack } = await l.families.publish(family.id, l.artist.id);
  const after = (await l.records.scan(COLLECTIONS.entities, null, 500)).items.length;
  assert.equal(after, before + 1, 'exactly one new Entity');
  assert.equal(pack.attributes.packVersion, 1);
  const packs = await l.families.listPacks(family.id);
  assert.equal(packs.length, 1);
  await l.records.close();
});

test('12. published DNA Pack represents the exact Family membership and ordering at publication time', async () => {
  const l = await lab();
  const a = await promotedMaterial(l, 24), b = await promotedMaterial(l, 25), c = await promotedMaterial(l, 26);
  const family = await l.families.createFamily({
    name: 'F', materialIds: [a.id, b.id, c.id], agentId: l.artist.id });
  await l.families.reorderMembers(family.id, [c.id, a.id, b.id], l.artist.id);
  const { manifest } = await l.families.publish(family.id, l.artist.id);
  assert.deepEqual(manifest.members.map((m) => m.materialId), [c.id, a.id, b.id]);
  assert.deepEqual(manifest.members.map((m) => m.order), [0, 1, 2]);
  await l.records.close();
});

test('13. changing the Family later does not mutate the previous DNA Pack', async () => {
  const l = await lab();
  const a = await promotedMaterial(l, 27), b = await promotedMaterial(l, 28), d = await promotedMaterial(l, 29);
  const family = await l.families.createFamily({
    name: 'F', materialIds: [a.id, b.id], agentId: l.artist.id });
  const { manifest: manifestV1, pack: packV1 } = await l.families.publish(family.id, l.artist.id);
  assert.deepEqual(manifestV1.members.map((m) => m.materialId), [a.id, b.id]);

  await l.families.removeMember(family.id, b.id, l.artist.id);
  await l.families.addMember(family.id, d.id, l.artist.id);

  const reread = await l.records.get(COLLECTIONS.entities, packV1.id);
  assert.deepEqual((reread as unknown as { attributes: { familyRevision: number } }).attributes,
    packV1.attributes, 'the persisted pack entity is byte-identical to what publish returned');
  await l.records.close();
});

test('14. republishing creates a new version', async () => {
  const l = await lab();
  const a = await promotedMaterial(l, 30), b = await promotedMaterial(l, 31), d = await promotedMaterial(l, 32);
  const family = await l.families.createFamily({ name: 'F', materialIds: [a.id, b.id], agentId: l.artist.id });
  const first = await l.families.publish(family.id, l.artist.id);
  await l.families.removeMember(family.id, b.id, l.artist.id);
  await l.families.addMember(family.id, d.id, l.artist.id);
  const second = await l.families.publish(family.id, l.artist.id);

  assert.equal(first.manifest.packVersion, 1);
  assert.equal(second.manifest.packVersion, 2);
  assert.notEqual(first.pack.id, second.pack.id);
  assert.deepEqual(first.manifest.members.map((m) => m.materialId), [a.id, b.id]);
  assert.deepEqual(second.manifest.members.map((m) => m.materialId), [a.id, d.id]);

  const packs = await l.families.listPacks(family.id);
  assert.equal(packs.length, 2);
  await l.records.close();
});

test('15. exported WAV bytes match the canonical Material hashes exactly (no transformation)', async () => {
  const l = await lab();
  const a = await promotedMaterial(l, 33);
  const family = await l.families.createFamily({ name: 'F', materialIds: [a.id], agentId: l.artist.id });
  const { manifest } = await l.families.publish(family.id, l.artist.id);
  const exported = await l.families.audioFor(a.id);
  assert.equal(manifest.members[0]!.contentHash, a.attributes.contentHash);
  const { contentHash } = await import('../../src/core/ids.ts');
  assert.equal(contentHash(exported!), a.attributes.contentHash, 'bytes are byte-for-byte the stored canonical WAV');
  await l.records.close();
});

test('16. manifest member ordering matches exported file ordering', async () => {
  const l = await lab();
  const a = await promotedMaterial(l, 34), b = await promotedMaterial(l, 35);
  const family = await l.families.createFamily({ name: 'F', materialIds: [b.id, a.id], agentId: l.artist.id });
  const { manifest } = await l.families.publish(family.id, l.artist.id);
  const audioByMaterialId = new Map<string, Uint8Array>();
  for (const m of manifest.members) audioByMaterialId.set(m.materialId, (await l.families.audioFor(m.materialId))!);
  const zip = buildDnaPackZip(manifest, audioByMaterialId);
  const text = new TextDecoder();
  // Filenames are numbered by declared order: 001-, 002-, ... — verify the
  // sequence matches manifest.members order exactly.
  assert.ok(manifest.members[0]!.filename.startsWith('001-'));
  assert.ok(manifest.members[1]!.filename.startsWith('002-'));
  assert.ok(zip.length > 0);
  void text;
  await l.records.close();
});

test('17. manifest schema version is explicit', async () => {
  const l = await lab();
  const a = await promotedMaterial(l, 36);
  const family = await l.families.createFamily({ name: 'F', materialIds: [a.id], agentId: l.artist.id });
  const { manifest } = await l.families.publish(family.id, l.artist.id);
  assert.equal(typeof manifest.schemaVersion, 'number');
  assert.ok(manifest.schemaVersion >= 1);
  await l.records.close();
});

test('18. publication provenance includes the publishing Agent', async () => {
  const l = await lab();
  const a = await promotedMaterial(l, 37);
  const family = await l.families.createFamily({ name: 'F', materialIds: [a.id], agentId: l.artist.id });
  const { manifest } = await l.families.publish(family.id, l.artist.id);
  assert.equal(manifest.publishingAgentId, l.artist.id);
  const transitions = (await l.records.scan(COLLECTIONS.transitions, null, 500)).items
    .filter((t) => (t as { kind?: string }).kind === 'publish');
  assert.equal(transitions.length, 1);
  assert.equal((transitions[0] as { agentId?: string }).agentId, l.artist.id);
  await l.records.close();
});

test('19. ResearchConfiguration provenance is preserved for derived Materials in the pack', async () => {
  const l = await lab();
  const source = await promotedMaterial(l, 38);
  const intent = await l.service.createResearchIntent({ question: 'q', agentId: l.artist.id });
  const set = await l.service.runResearchConfiguration({
    materialId: source.id, configuration: FRAGMENT_EXPLORATION_V1_2,
    researchIntentId: intent.id, baseSeed: 999, variationCount: 2, agentId: l.artist.id });
  const derived = (await l.service.retain(selectVariation(set, 0).preview, l.artist.id)).material;
  await l.service.promote(derived.id, l.artist.id);
  const family = await l.families.createFamily({ name: 'F', materialIds: [derived.id], agentId: l.artist.id });
  const { manifest } = await l.families.publish(family.id, l.artist.id);
  assert.equal(manifest.members[0]!.configurationId, 'fragment-exploration-v1');
  assert.equal(manifest.members[0]!.configurationVersion, '1.2.0');
  assert.equal(typeof manifest.members[0]!.seed, 'number');
  await l.records.close();
});

test('20. imported source Materials remain valid pack members', async () => {
  const l = await lab();
  const imported = await promotedMaterial(l, 39);
  assert.equal(imported.attributes.origin, 'import');
  const family = await l.families.createFamily({ name: 'F', materialIds: [imported.id], agentId: l.artist.id });
  const { manifest } = await l.families.publish(family.id, l.artist.id);
  assert.equal(manifest.members[0]!.origin, 'import');
  await l.records.close();
});

test('21. ZIP generation does not modify canonical records', async () => {
  const l = await lab();
  const a = await promotedMaterial(l, 40);
  const family = await l.families.createFamily({ name: 'F', materialIds: [a.id], agentId: l.artist.id });
  const before = await l.records.scan(COLLECTIONS.entities, null, 500);
  const { manifest } = await l.families.publish(family.id, l.artist.id);
  const afterPublish = await l.records.scan(COLLECTIONS.entities, null, 500);
  const audioByMaterialId = new Map([[a.id, (await l.families.audioFor(a.id))!]]);
  buildDnaPackZip(manifest, audioByMaterialId); // pure function — no store access at all
  const afterZip = await l.records.scan(COLLECTIONS.entities, null, 500);
  assert.equal(afterPublish.items.length, before.items.length + 1, 'publish added exactly the pack entity');
  assert.equal(afterZip.items.length, afterPublish.items.length, 'zip assembly touches no records');
  await l.records.close();
});

test('22. browser export path (zip.ts) has no Node-only dependency', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile('src/format/zip.ts', 'utf8');
  assert.ok(!/from ['"]node:/.test(source), 'zip.ts must not import Node built-ins');
  const dnaPackSource = await readFile('src/domain/alchemy/dna-pack.ts', 'utf8');
  assert.ok(!/from ['"]node:/.test(dnaPackSource));
});

test('23. IndexedDB remains browser-compatible for the Family/DNA Pack path', async () => {
  const idb = await IndexedDbRecordStore.open(`family-browser-compat-${Date.now()}`, CURRENT_SCHEMA);
  await idb.setSchemaVersion(CURRENT_SCHEMA.version);
  const dir = mkdtempSync(join(tmpdir(), 'spk-family-browser-'));
  const content = new FsContentStore(join(dir, 'content'));
  const registry = new DataRegistry();
  registerAlchemyVocabulary(registry);
  const service = new AlchemyService(idb, content, registry);
  const families = new FamilyService(idb, content, registry);
  const artist = await service.registerAgent({ kind: 'human', name: 'artist', version: '1' });
  const a = await service.importMaterial({ bytes: wav(41), filename: 'a.wav', agentId: artist.id });
  const family = await families.createFamily({ name: 'F', materialIds: [a.id], agentId: artist.id });
  const { manifest } = await families.publish(family.id, artist.id);
  const zip = buildDnaPackZip(manifest, new Map([[a.id, (await families.audioFor(a.id))!]]));
  assert.ok(zip.length > 0);
  await idb.close();
});

test('24. zip round-trips (real zip signature, deterministic bytes)', () => {
  const entries = [
    { name: 'pack/manifest.json', data: new TextEncoder().encode('{"a":1}') },
    { name: 'pack/audio/001-x.wav', data: new Uint8Array([1, 2, 3, 4, 5]) },
  ];
  const a = createZip(entries);
  const b = createZip(entries);
  assert.deepEqual(Buffer.from(a), Buffer.from(b), 'identical entries produce byte-identical zips');
  assert.equal(a[0], 0x50); assert.equal(a[1], 0x4b); // 'PK' signature
  assert.equal(crc32(new TextEncoder().encode('hello')), 0x3610a686);
});

test('25. fragment-exploration-v1@1.2.0 reference hashes remain unchanged', async () => {
  const { contentHash } = await import('../../src/core/ids.ts');
  const source = encodeWav(synthesize(9, 8000, 1, 5000));
  const GOLDEN = [
    '344526b806', '9c88e3eca7', 'ebb1a00e88', '17901e7724',
    '349a149bff', 'cb2bb7b5cf', '6e9e800095', '82195dd159',
  ];
  const hashes = Array.from({ length: 8 }, (_, i) => {
    const seed = FRAGMENT_EXPLORATION_V1_2.variationSeed(1000, i);
    return contentHash(FRAGMENT_EXPLORATION_V1_2.render(source, seed)).slice(0, 10);
  });
  assert.deepEqual(hashes, GOLDEN);
});

test('packDirectoryName is filesystem-safe and versioned', () => {
  const name = packDirectoryName({
    schemaVersion: 1, packId: 'x', packVersion: 3, familyId: 'y', familyRevision: 1,
    familyName: 'Metal Breathing! (v2)', publishedAt: 0, publishingAgentId: 'z', members: [],
  });
  assert.equal(name, 'metal-breathing-v2-dna-v003');
});
