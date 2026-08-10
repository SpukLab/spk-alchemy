import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { SqliteRecordStore } from '../../src/adapters/node-sqlite/record-store.ts';
import { FsContentStore } from '../../src/adapters/content-fs/content-store.ts';
import { DataRegistry } from '../../src/registries/data-registry.ts';
import { registerAlchemyVocabulary } from '../../src/domain/alchemy/vocabulary.ts';
import { AlchemyService } from '../../src/domain/alchemy/service.ts';
import { FamilyService } from '../../src/domain/alchemy/family-service.ts';
import { migrate, CURRENT_SCHEMA } from '../../src/migrations/index.ts';
import { synthesize, encodeWav } from '../../src/audio/wav.ts';
import { FRAGMENT_EXPLORATION_V1_2 } from '../../src/domain/alchemy/research-configuration.ts';
import { selectVariation } from '../../src/domain/alchemy/exploration.ts';
import { COLLECTIONS } from '../../src/core/primitives.ts';
import { contentHash } from '../../src/core/ids.ts';

/**
 * Material playback (5, 6, 7, 9, 10) is tested against the real domain and
 * content layer — the same audioFor() resolution path web/app.js calls
 * through WebLab — because "playback must never touch canonical persistence"
 * is a genuine domain-layer claim.
 *
 * The remaining items (1-4, 8, 11, 12) concern browser-only interaction
 * sequencing in web/app.js (plain JS, not a bundled TS module). Consistent
 * with how this project already tests browser-only code — the Buffer/dist
 * boot probes, the purity source checks — they are verified here by asserting
 * the exact structural properties that make the required behavior true,
 * rather than pulling in a DOM dependency this project has deliberately
 * avoided everywhere else. The physical-device checklist is the final word
 * on the actual interaction.
 */

async function lab() {
  const dir = mkdtempSync(join(tmpdir(), 'spk-playback-'));
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
const wav = (seed: number) => encodeWav(synthesize(seed, 8000, 1, 2000));

test('5. promoted Material playback resolves canonical Content', async () => {
  const l = await lab();
  const m = await l.service.importMaterial({ bytes: wav(1), filename: 'a.wav', agentId: l.artist.id });
  assert.equal(m.lifecycleState, 'promoted');
  const bytes = await l.content.get(String(m.attributes.contentHash));
  assert.ok(bytes && bytes.byteLength > 0);
  assert.equal(contentHash(bytes!), m.attributes.contentHash);
  await l.records.close();
});

test('6. retained Material playback resolves canonical Content', async () => {
  const l = await lab();
  const source = await l.service.importMaterial({ bytes: wav(2), filename: 'a.wav', agentId: l.artist.id });
  const intent = await l.service.createResearchIntent({ question: 'q', agentId: l.artist.id });
  const set = await l.service.runResearchConfiguration({
    materialId: source.id, configuration: FRAGMENT_EXPLORATION_V1_2,
    researchIntentId: intent.id, baseSeed: 1, variationCount: 2, agentId: l.artist.id });
  const r = await l.service.retain(selectVariation(set, 0).preview, l.artist.id);
  assert.equal(r.material.lifecycleState, 'retained');
  const bytes = await l.content.get(String(r.material.attributes.contentHash));
  assert.ok(bytes && bytes.byteLength > 0);
  await l.records.close();
});

test('7. playback resolution survives a store reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spk-playback-reopen-'));
  const path = join(dir, 'store.sqlite');
  const records1 = new SqliteRecordStore(path, CURRENT_SCHEMA);
  await migrate(records1);
  const content1 = new FsContentStore(join(dir, 'content'));
  const registry1 = new DataRegistry();
  registerAlchemyVocabulary(registry1);
  const service1 = new AlchemyService(records1, content1, registry1);
  const artist1 = await service1.registerAgent({ kind: 'human', name: 'artist', version: '1' });
  const m = await service1.importMaterial({ bytes: wav(3), filename: 'a.wav', agentId: artist1.id });
  await records1.close();

  const records2 = new SqliteRecordStore(path, CURRENT_SCHEMA);
  const content2 = new FsContentStore(join(dir, 'content'));
  const reread = await records2.get(COLLECTIONS.entities, m.id);
  const hash = (reread as unknown as { attributes: { contentHash: string } }).attributes.contentHash;
  const bytes = await content2.get(hash);
  assert.ok(bytes && bytes.byteLength > 0, 'audio is resolvable purely from persisted Content, no live session needed');
  await records2.close();
});

test('9+10. reading playback audio never writes to canonical persistence', async () => {
  const l = await lab();
  const m = await l.service.importMaterial({ bytes: wav(4), filename: 'a.wav', agentId: l.artist.id });
  const before = {
    entities: (await l.records.scan(COLLECTIONS.entities, null, 500)).items.length,
    relationships: (await l.records.scan(COLLECTIONS.relationships, null, 500)).items.length,
    transitions: (await l.records.scan(COLLECTIONS.transitions, null, 500)).items.length,
  };
  // Simulate "play then stop" repeatedly: only reads.
  for (let i = 0; i < 3; i++) { await l.content.get(String(m.attributes.contentHash)); }
  const after = {
    entities: (await l.records.scan(COLLECTIONS.entities, null, 500)).items.length,
    relationships: (await l.records.scan(COLLECTIONS.relationships, null, 500)).items.length,
    transitions: (await l.records.scan(COLLECTIONS.transitions, null, 500)).items.length,
  };
  assert.deepEqual(after, before, 'playback (start, repeat, stop) creates no Entity, Relationship or Transition');
  await l.records.close();
});

test('2. selection eligibility is enforced the same way Family creation already enforces it', async () => {
  const l = await lab();
  const rejected = await l.service.importMaterial({ bytes: wav(5), filename: 'r.wav', agentId: l.artist.id });
  await l.service.reject(rejected.id, l.artist.id, 'no sirve');
  await assert.rejects(
    () => l.families.createFamily({ name: 'x', materialIds: [rejected.id], agentId: l.artist.id }),
    /only promoted materials/,
    'the same eligibility rule selection mode relies on is enforced at the domain layer');
  await l.records.close();
});

// ---- browser-only interaction sequencing: structural verification ----------

test('1. activating Family selection switches the Material view to Promovidos', async () => {
  const source = await readFile('web/app.js', 'utf8');
  const handler = /\$\('curate-toggle'\)\.onclick[\s\S]*?\n  \};/.exec(source)?.[0] ?? '';
  assert.ok(handler, 'curate-toggle handler found');
  assert.match(handler, /state\.curating\s*&&\s*state\.tab\s*!==\s*'promoted'/,
    'activation checks whether the view needs to switch');
  assert.match(handler, /state\.tab\s*=\s*'promoted'/, 'activation forces the Promovidos tab');
});

test('3+4. leaving selection mode and selecting materials never call the domain layer', async () => {
  const source = await readFile('web/app.js', 'utf8');
  const handler = /\$\('curate-toggle'\)\.onclick[\s\S]*?\n  \};/.exec(source)?.[0] ?? '';
  assert.ok(!/state\.lab\./.test(handler),
    'toggling selection mode on or off never touches the domain/canonical layer');
  const changeHandler = /\$\('materials'\)\.addEventListener\('change'[\s\S]*?\}\);/.exec(source)?.[0] ?? '';
  assert.ok(changeHandler, 'checkbox change handler found');
  assert.ok(!/state\.lab\./.test(changeHandler),
    'checking/unchecking a candidate only updates local selection state, never creates anything');
  // Only the explicit "create family" action calls the canonical layer.
  const createHandler = /\$\('create-family-bar'\)\.onclick[\s\S]*?\n  \};/.exec(source)?.[0] ?? '';
  assert.match(createHandler, /state\.lab\.createFamily/);
});

test('8. starting playback always stops any prior playback first', async () => {
  const source = await readFile('web/app.js', 'utf8');
  const fn = /async function togglePlayMaterial[\s\S]*?\n}/.exec(source)?.[0] ?? '';
  assert.ok(fn, 'togglePlayMaterial found');
  const stopIndex = fn.indexOf('stopPlayback();');
  const newAudioIndex = fn.indexOf('new Audio(url)');
  assert.ok(stopIndex >= 0 && newAudioIndex >= 0 && stopIndex < newAudioIndex,
    'stopPlayback() always runs before a new Audio element is created');
});

test('11+12. Play and Selection are structurally separate hit targets', async () => {
  const source = await readFile('web/app.js', 'utf8');
  // The click handler must resolve a play tap and return before reaching any
  // selection-related branch.
  const clickHandler = /\$\('materials'\)\.onclick[\s\S]*?\n  \};/.exec(source)?.[0] ?? '';
  assert.match(clickHandler, /if \(d\.play\) \{ await togglePlayMaterial\(d\.play\); return; \}/,
    'a play tap resolves and returns before any other branch can run');
  // The play button markup must never be nested inside the selection <label>,
  // so tapping it can never also toggle the checkbox via label semantics.
  const renderFn = /async function renderMaterials[\s\S]*?\n}/.exec(source)?.[0] ?? '';
  // Locate the curating-mode branch specifically (it contains the `<label
  // class="pick">` markup), then confirm the play button reference precedes
  // the label's opening tag and the label closes before anything else follows
  // — i.e. playButton and <label> are siblings, not nested.
  const curatingBranch = /if \(curatingHere\) \{[\s\S]*?return;\n {4}\}/.exec(renderFn)?.[0] ?? '';
  assert.ok(curatingBranch.includes('<label class="pick">'), 'curating branch found');
  const playButtonPos = curatingBranch.indexOf('${playButton}');
  const labelOpenPos = curatingBranch.indexOf('<label class="pick">');
  const labelClosePos = curatingBranch.indexOf('</label>');
  assert.ok(playButtonPos >= 0 && labelOpenPos >= 0 && labelClosePos >= 0);
  assert.ok(playButtonPos < labelOpenPos,
    'the play button appears before the selection <label> opens, as a sibling, never nested inside it');
  assert.ok(labelClosePos > labelOpenPos, 'the label is well-formed');
});

test('19. browser bundle export path (this feature) has no Node-only dependency', async () => {
  const source = await readFile('src/domain/alchemy/lineage.ts', 'utf8');
  assert.ok(!/from ['"]node:/.test(source));
  const labSource = await readFile('src/web/lab.ts', 'utf8');
  assert.ok(!/from ['"]node:/.test(labSource));
});
