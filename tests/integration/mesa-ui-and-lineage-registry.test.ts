import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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
import {
  DEFAULT_MESA_STATE, validateMesaState, runMesaExploration,
  MEDIUM_STRATEGIES, UNEXPECTED_STRATEGIES,
} from '../../src/domain/alchemy/mesa.ts';
import { strategyLabel, territoryLabel, missingStrategyLabels } from '../../src/domain/alchemy/mesa-labels.ts';
import { LineageColorRegistry, MemoryLineageStore } from '../../src/domain/alchemy/lineage-registry.ts';
import type { LineageRegistryStore } from '../../src/domain/alchemy/lineage-registry.ts';
import { LINEAGE_PALETTE, MULTI_ROOT_COLOR } from '../../src/domain/alchemy/lineage.ts';
import { COLLECTIONS } from '../../src/core/primitives.ts';

const wav = (seed: number) => encodeWav(synthesize(seed, 8000, 1, 3000));

async function lab() {
  const dir = mkdtempSync(join(tmpdir(), 'spk-mesaui-'));
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

// ---- Mesa UI wiring ------------------------------------------------------

/** Mirrors app.js readMesaState()/initMesaSliders() against a fake slider set. */
const SLIDER_MAP: readonly [string, keyof typeof DEFAULT_MESA_STATE, string][] = [
  ['mesa-fragmentar-escala', 'fragmentar', 'escala'],
  ['mesa-fragmentar-desorden', 'fragmentar', 'desorden'],
  ['mesa-acelerar-tiempo', 'acelerar', 'tiempo'],
  ['mesa-acelerar-movimiento', 'acelerar', 'movimiento'],
  ['mesa-microscopio-zoom', 'microscopio', 'zoom'],
  ['mesa-microscopio-persistencia', 'microscopio', 'persistencia'],
  ['mesa-excitar-energia', 'excitar', 'energia'],
  ['mesa-excitar-estabilidad', 'excitar', 'estabilidad'],
];

function makeSliders(defaults = DEFAULT_MESA_STATE): Map<string, { value: string }> {
  const sliders = new Map<string, { value: string }>();
  for (const [id, tool, control] of SLIDER_MAP) {
    sliders.set(id, { value: String((defaults[tool] as Record<string, number>)[control]) });
  }
  return sliders;
}
function readFromSliders(sliders: Map<string, { value: string }>) {
  const s: Record<string, Record<string, number>> = {
    fragmentar: {}, acelerar: {}, microscopio: {}, excitar: {} };
  for (const [id, tool, control] of SLIDER_MAP) s[tool]![control] = Number(sliders.get(id)!.value);
  return s as unknown as typeof DEFAULT_MESA_STATE;
}

test('1+2. mode switching shows exactly one panel; both panels exist in markup', async () => {
  const html = await readFile('web/index.html', 'utf8');
  assert.ok(html.includes('id="mesa-panel"'), 'Mesa panel exists');
  assert.ok(html.includes('id="quick-explore-panel"'), 'Rápida panel exists');
  const app = await readFile('web/app.js', 'utf8');
  const fn = /function setExploreMode\([\s\S]*?\n}/.exec(app)?.[0] ?? '';
  assert.match(fn, /quick-explore-panel'\)\.hidden = mode !== 'quick'/);
  assert.match(fn, /mesa-panel'\)\.hidden = mode !== 'mesa'/);
});

test('the mode tabs are no longer clobbered by the materials tab selector (device root cause)', async () => {
  const app = await readFile('web/app.js', 'utf8');
  // An unscoped '[role=tab]' selector previously matched the Rápida/Mesa mode
  // tabs and, running later in wire(), overwrote their handlers -- so tapping
  // "Mesa" ran the materials handler, set state.tab = undefined, and never
  // revealed the Mesa panel. Every wiring selector must now be scoped.
  assert.ok(!/querySelectorAll\('\[role=tab\]'\)/.test(app),
    'no unscoped [role=tab] selector may remain');
  assert.ok(/querySelectorAll\('#material-tabs \[role=tab\]'\)/.test(app));
  assert.ok(/querySelectorAll\('#explore-mode-tabs \[role=tab\]'\)/.test(app));
});

test('3+6..13. all eight controls map to exactly one distinct MesaState field', () => {
  assert.equal(SLIDER_MAP.length, 8);
  assert.equal(new Set(SLIDER_MAP.map(([id]) => id)).size, 8, 'eight distinct control ids');
  assert.equal(new Set(SLIDER_MAP.map(([, t, c]) => `${t}.${c}`)).size, 8, 'eight distinct fields');

  // Each control, moved individually, changes exactly its own field.
  for (const [id, tool, control] of SLIDER_MAP) {
    const sliders = makeSliders();
    const before = readFromSliders(sliders);
    sliders.get(id)!.value = '17';
    const after = readFromSliders(sliders);
    assert.equal((after[tool] as Record<string, number>)[control], 17, `${id} drives ${tool}.${control}`);
    for (const [, otherTool, otherControl] of SLIDER_MAP) {
      if (otherTool === tool && otherControl === control) continue;
      assert.equal((after[otherTool] as Record<string, number>)[otherControl],
        (before[otherTool] as Record<string, number>)[otherControl],
        `${id} must not disturb ${otherTool}.${otherControl}`);
    }
  }
});

test('4+5. defaults come from the domain object, and reset restores exactly those', () => {
  const sliders = makeSliders();
  assert.deepEqual(readFromSliders(sliders), DEFAULT_MESA_STATE, 'initial values are the domain defaults');
  for (const [id] of SLIDER_MAP) sliders.get(id)!.value = '3';
  assert.notDeepEqual(readFromSliders(sliders), DEFAULT_MESA_STATE);
  // Reset re-applies initMesaSliders(), i.e. writes the domain defaults back.
  for (const [id, tool, control] of SLIDER_MAP) {
    sliders.get(id)!.value = String((DEFAULT_MESA_STATE[tool] as Record<string, number>)[control]);
  }
  assert.deepEqual(readFromSliders(sliders), DEFAULT_MESA_STATE);
});

test('defaults are read through the browser boundary, not duplicated in the UI', async () => {
  const html = await readFile('web/index.html', 'utf8');
  // Every slider ships value="0" and is populated from lab.defaultMesaState at
  // boot -- no default number is hardcoded a second time in markup.
  for (const [, tool, control] of SLIDER_MAP) {
    const value = (DEFAULT_MESA_STATE[tool] as Record<string, number>)[control];
    assert.ok(!html.includes(`value="${value}"`) || value === 0,
      `default ${tool}.${control}=${value} must not be hardcoded in HTML`);
  }
  const app = await readFile('web/app.js', 'utf8');
  assert.match(app, /state\.lab\.defaultMesaState/, 'UI reads defaults from the lab boundary');
});

test('14. Mesa exploration receives the CURRENT slider state, not the defaults', () => {
  const sliders = makeSliders();
  sliders.get('mesa-excitar-energia')!.value = '95';
  const current = readFromSliders(sliders);
  assert.notEqual(current.excitar.energia, DEFAULT_MESA_STATE.excitar.energia);

  // The engine must actually respond to that difference.
  const source = wav(9);
  const withDefaults = runMesaExploration(source, DEFAULT_MESA_STATE, 1000);
  const withCurrent = runMesaExploration(source, validateMesaState(current), 1000);
  let differing = 0;
  for (let i = 0; i < 8; i++) {
    if (Buffer.compare(Buffer.from(withDefaults[i]!.bytes), Buffer.from(withCurrent[i]!.bytes)) !== 0) {
      differing += 1;
    }
  }
  assert.ok(differing > 0, 'changing a control must change generated output');
});

test('16+17. Mesa returns 4 MEDIUM + 4 UNEXPECTED, and grouping uses territory metadata', () => {
  const obs = runMesaExploration(wav(9), DEFAULT_MESA_STATE, 1000);
  assert.equal(obs.filter((o) => o.territory === 'medium').length, 4);
  assert.equal(obs.filter((o) => o.territory === 'unexpected').length, 4);
  // Grouping must filter by the metadata field, never by index position.
  const grouped = { medium: obs.filter((o) => o.territory === 'medium'),
                    unexpected: obs.filter((o) => o.territory === 'unexpected') };
  for (const o of grouped.medium) assert.equal(o.territory, 'medium');
  for (const o of grouped.unexpected) assert.equal(o.territory, 'unexpected');
});

test('18+19+20+21. strategy metadata drives correct visible labels, never "Variación N"', () => {
  assert.deepEqual(missingStrategyLabels(), [], 'every registered strategy has a label');
  assert.deepEqual(MEDIUM_STRATEGIES.map((s) => strategyLabel(s.id)),
    ['Estructura', 'Fragmentación', 'Temporal', 'Textura']);
  assert.deepEqual(UNEXPECTED_STRATEGIES.map((s) => strategyLabel(s.id)),
    ['Temporal', 'Microscópica', 'Energética', 'Híbrida']);
  assert.equal(territoryLabel('medium'), 'Observaciones medias');
  assert.equal(territoryLabel('unexpected'), 'Observaciones inesperadas');

  const obs = runMesaExploration(wav(9), DEFAULT_MESA_STATE, 1000);
  for (const o of obs) {
    const label = strategyLabel(o.strategyId);
    assert.ok(!/^Variación/.test(label), `"${label}" must not be a generic variation name`);
    assert.notEqual(label, o.strategyId, 'the raw identifier is never shown directly');
  }
});

test('15. Rápida remains unchanged and carries no Mesa controls', async () => {
  const html = await readFile('web/index.html', 'utf8');
  const quickPanel = /<div id="quick-explore-panel">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
  assert.ok(quickPanel.length > 0);
  for (const [id] of SLIDER_MAP) {
    assert.ok(!quickPanel.includes(id), `Rápida must not contain ${id}`);
  }
});

// ---- Lineage color registry ------------------------------------------------

test('23+24+25. unrelated roots receive distinct slots while capacity remains', async () => {
  const reg = new LineageColorRegistry(new MemoryLineageStore());
  const slots: number[] = [];
  for (let i = 0; i < LINEAGE_PALETTE.length; i++) slots.push(await reg.slotForRoot(`root-${i}`));
  assert.equal(new Set(slots).size, LINEAGE_PALETTE.length,
    'every root up to palette capacity gets its own slot -- no collisions');
});

test('33. adding a new root never reassigns an existing one', async () => {
  const reg = new LineageColorRegistry(new MemoryLineageStore());
  const first = await reg.slotForRoot('root-a');
  const before = await reg.assignments();
  for (let i = 0; i < 20; i++) await reg.slotForRoot(`other-${i}`);
  assert.equal(await reg.slotForRoot('root-a'), first, 'the original slot is untouched');
  assert.equal((await reg.assignments())['root-a'], before['root-a']);
});

test('34. palette exhaustion is deterministic and disturbs nothing existing', async () => {
  const reg = new LineageColorRegistry(new MemoryLineageStore());
  for (let i = 0; i < LINEAGE_PALETTE.length; i++) await reg.slotForRoot(`fill-${i}`);
  const overflowA = await reg.slotForRoot('overflow-root');
  const overflowB = await reg.slotForRoot('overflow-root');
  assert.equal(overflowA, overflowB, 'the overflow assignment is stable');

  const reg2 = new LineageColorRegistry(new MemoryLineageStore());
  for (let i = 0; i < LINEAGE_PALETTE.length; i++) await reg2.slotForRoot(`fill-${i}`);
  assert.equal(await reg2.slotForRoot('overflow-root'), overflowA,
    'the same overflow root resolves identically in an equivalent registry');
});

test('28. assignments survive a reload through the injected store', async () => {
  const shared: { data: Record<string, number> } = { data: {} };
  const store: LineageRegistryStore = {
    async read() { return { ...shared.data }; },
    async write(a) { shared.data = { ...a }; },
  };
  const before = new LineageColorRegistry(store);
  const slot = await before.slotForRoot('persistent-root');
  // A fresh registry instance simulates an app reopen against the same store.
  const after = new LineageColorRegistry(store);
  assert.equal(await after.slotForRoot('persistent-root'), slot);
});

test('26+27+29+30+31. descendants inherit the root slot across generations, lifecycle, Family and publication', async () => {
  const l = await lab();
  const reg = new LineageColorRegistry(new MemoryLineageStore());
  const root = await l.service.importMaterial({ bytes: wav(1), filename: 'a.wav', agentId: l.artist.id });
  const rootColor = await reg.colorForMaterial(root.id, l.queries);

  const intent = await l.service.createResearchIntent({ question: 'q', agentId: l.artist.id });
  const set = await l.service.runMesaExploration({
    materialId: root.id, researchIntentId: intent.id,
    mesaState: DEFAULT_MESA_STATE, baseSeed: 1, agentId: l.artist.id });
  const child = (await l.service.retain(set.variations[4]!.preview, l.artist.id)).material;
  assert.equal(await reg.colorForMaterial(child.id, l.queries), rootColor, 'direct child inherits');

  await l.service.promote(child.id, l.artist.id);
  assert.equal(await reg.colorForMaterial(child.id, l.queries), rootColor, 'Promote does not alter it');

  const set2 = await l.service.runMesaExploration({
    materialId: child.id, researchIntentId: intent.id,
    mesaState: DEFAULT_MESA_STATE, baseSeed: 2, agentId: l.artist.id });
  const grandchild = (await l.service.retain(set2.variations[0]!.preview, l.artist.id)).material;
  assert.equal(await reg.colorForMaterial(grandchild.id, l.queries), rootColor,
    'second-generation descendant still inherits the original root slot');

  await l.service.promote(grandchild.id, l.artist.id);
  const family = await l.families.createFamily({
    name: 'F', materialIds: [child.id], agentId: l.artist.id });
  assert.equal(await reg.colorForMaterial(child.id, l.queries), rootColor, 'Family membership does not alter it');
  await l.families.publish(family.id, l.artist.id);
  assert.equal(await reg.colorForMaterial(child.id, l.queries), rootColor, 'publication does not alter it');
  await l.records.close();
});

test('32. two roots that collided under hash-modulo can be separated by the registry', async () => {
  // Find two ids that genuinely collide under the old hash % size rule.
  const { paletteIndexForRoot } = await import('../../src/domain/alchemy/lineage.ts');
  let a: string | null = null, b: string | null = null;
  for (let i = 0; i < 500 && (a === null || b === null); i++) {
    const id = `collide-${i}`;
    if (paletteIndexForRoot(id) !== 0) continue;
    if (a === null) a = id; else b = id;
  }
  assert.ok(a && b, 'found two ids colliding under the old rule');
  assert.equal(paletteIndexForRoot(a!), paletteIndexForRoot(b!), 'they really did collide before');

  const reg = new LineageColorRegistry(new MemoryLineageStore());
  const slotA = await reg.slotForRoot(a!);
  const slotB = await reg.slotForRoot(b!);
  assert.notEqual(slotA, slotB, 'the registry separates them into free slots');
});

test('35+36. one failed root resolution never breaks the others, and falls back neutrally', async () => {
  const l = await lab();
  const reg = new LineageColorRegistry(new MemoryLineageStore());
  const good = await l.service.importMaterial({ bytes: wav(2), filename: 'g.wav', agentId: l.artist.id });

  const brokenQueries = {
    ancestors: async (id: string) => {
      if (id === 'broken') throw new Error('simulated genealogy failure');
      return l.queries.ancestors(id);
    },
  } as unknown as AlchemyQueries;

  const results = await Promise.all([good.id, 'broken', good.id].map(async (id) => {
    try { return await reg.colorForMaterial(id, brokenQueries); }
    catch { return MULTI_ROOT_COLOR; } // the UI's safeLineageColor fallback
  }));
  assert.ok(LINEAGE_PALETTE.includes(results[0]!), 'the healthy material still resolves');
  assert.equal(results[1], MULTI_ROOT_COLOR, 'the failing one falls back neutrally');
  assert.ok(LINEAGE_PALETTE.includes(results[2]!), 'later materials are unaffected');
  assert.ok(!LINEAGE_PALETTE.includes(MULTI_ROOT_COLOR),
    'the fallback is visually distinct from every real lineage color');
  await l.records.close();
});

test('37+38. no canonical attribute or primitive was added for UI color', async () => {
  const l = await lab();
  const reg = new LineageColorRegistry(new MemoryLineageStore());
  const m = await l.service.importMaterial({ bytes: wav(3), filename: 'a.wav', agentId: l.artist.id });
  await reg.colorForMaterial(m.id, l.queries);
  const stored = await l.records.get(COLLECTIONS.entities, m.id);
  const attributes = (stored as unknown as { attributes: Record<string, unknown> }).attributes;
  for (const key of Object.keys(attributes)) {
    assert.ok(!/color|palette|slot|lineage/i.test(key),
      `canonical attributes must carry no UI color field (found "${key}")`);
  }
  const registrySource = await readFile('src/domain/alchemy/lineage-registry.ts', 'utf8');
  // Strip comments before matching: the module documents its own boundary by
  // NAMING RecordStore in prose ("never touches RecordStore"), which is the
  // opposite of a violation. Only executable code counts -- the same lesson
  // as the earlier SQL/Math.random/global false positives.
  const registryCode = registrySource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/RecordStore|COLLECTIONS\./.test(registryCode),
    'the registry never touches canonical persistence');
  const primitives = await readFile('src/core/primitives.ts', 'utf8');
  const collections = [...primitives.matchAll(/^\s{2}(\w+):\s*'(\w+)',$/gm)].map((x) => x[2]);
  assert.deepEqual(collections.sort(),
    ['agents', 'entities', 'knowledge', 'meta', 'relationships', 'transitions']);
  await l.records.close();
});

test('39. new modules remain free of Node built-ins', async () => {
  for (const file of [
    'src/domain/alchemy/lineage-registry.ts',
    'src/domain/alchemy/mesa-labels.ts',
  ]) {
    const source = await readFile(file, 'utf8');
    assert.ok(!/from ['"]node:/.test(source), `${file} must not import Node built-ins`);
  }
});
