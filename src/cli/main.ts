import { rm } from 'node:fs/promises';
import { openLab } from './context.ts';
import { synthesize, encodeWav } from '../audio/wav.ts';
import { ANALYZER_V1, ANALYZER_V2 } from '../audio/analyzer.ts';
import { LIFECYCLE } from '../domain/alchemy/vocabulary.ts';
import { KNOWLEDGE_KIND } from '../domain/alchemy/vocabulary.ts';
import { COLLECTIONS } from '../core/primitives.ts';

const ROOT = process.env.SPK_DATA_ROOT ?? '.data';
const log = (...a: unknown[]): void => { console.log(...a); };
const heading = (t: string): void => { console.log(`\n=== ${t} ===`); };

async function cmdMigrate(): Promise<void> {
  const lab = await openLab(ROOT);
  log(`schema version: ${await lab.records.schemaVersion()}`);
  await lab.close();
}

async function cmdReset(): Promise<void> {
  await rm(ROOT, { recursive: true, force: true });
  log(`removed ${ROOT}`);
}

async function cmdDemo(): Promise<void> {
  const lab = await openLab(ROOT);
  const artist = await lab.service.registerAgent({ kind: 'human', name: 'artist', version: '1' });
  const av1 = await lab.service.registerAgent({ kind: 'analyzer', name: 'physical-analyzer', version: '1.0.0' });
  const av2 = await lab.service.registerAgent({ kind: 'analyzer', name: 'physical-analyzer', version: '2.0.0' });

  heading('import');
  const bytes = encodeWav(synthesize(7, 8000, 1, 6000));
  const source = await lab.service.importMaterial({ bytes, filename: 'seed-07.wav', agentId: artist.id });
  log(`material ${source.id} hash=${String(source.attributes.contentHash).slice(0, 12)}…`);

  heading('observations (two analyzer versions coexist)');
  await lab.service.analyzeMaterial(source.id, ANALYZER_V1, av1.id);
  await lab.service.analyzeMaterial(source.id, ANALYZER_V2, av2.id);
  for (const [group, list] of await lab.queries.observationsForMaterial(source.id)) {
    log(`  ${group}: ${list.length} observation(s)`);
  }

  heading('research intent + experiment');
  const intent = await lab.service.createResearchIntent({
    question: 'investigate liquid rhythmic material',
    successCriteria: 'retained material reads as continuous rather than struck',
    agentId: artist.id,
  });
  const experiment = await lab.service.createExperiment({
    researchIntentId: intent.id, inputMaterialIds: [source.id],
    operation: 'reverse', agentId: artist.id,
  });
  log(`intent ${intent.id}\nexperiment ${experiment.id}`);

  heading('preview -> discard (nothing persists)');
  const discarded = await lab.service.runExperiment(experiment.id);
  lab.service.discardPreview(discarded);
  log(`discarded preview ${discarded.stagingRef} — no Entity, no Transition`);

  heading('preview -> retain -> promote');
  const preview = await lab.service.runExperiment(experiment.id);
  const retained = await lab.service.retain(preview, artist.id, 'worth laboratory memory');
  log(`retained material ${retained.material.id} state=${retained.material.lifecycleState}`);
  const promoted = await lab.service.promote(retained.material.id, artist.id, 'keeper');
  log(`promoted same UUID ${promoted.material.id} state=${promoted.material.lifecycleState}`);

  heading('reject a second derivation');
  const preview2 = await lab.service.runExperiment(experiment.id);
  // Same experiment, same inputs: deterministic, so the same content hash.
  log(`deterministic rerun hash match: ${preview.contentHash === preview2.contentHash}`);

  heading('canon knowledge');
  await lab.service.assertKnowledge({
    subject: retained.material.id, kind: KNOWLEDGE_KIND.curatedConclusion,
    stage: 'canon', payload: { note: 'reversal preserves the tail as an onset' },
    agentId: artist.id, confidence: 0.9,
  });
  log(`canon records: ${(await lab.queries.canonKnowledgeForSubject(retained.material.id)).length}`);

  heading('genealogy');
  const anc = await lab.queries.ancestors(retained.material.id);
  log(`ancestors of retained: ${anc.nodes.map((n) => `${n.id.slice(0, 8)}…@d${n.depth}`).join(', ')}`);
  const desc = await lab.queries.descendants(source.id);
  log(`descendants of source: ${desc.nodes.map((n) => `${n.id.slice(0, 8)}…@d${n.depth}`).join(', ')}`);

  heading('transitions (full provenance)');
  for (const t of await lab.queries.transitionsFor(retained.material.id)) {
    log(`  ${t.kind}: ${t.fromState ?? '∅'} -> ${t.toState} by ${t.agentId.slice(0, 8)}…`);
  }
  await lab.close();
}

async function cmdSeed(): Promise<void> {
  const lab = await openLab(ROOT);
  const artist = await lab.service.registerAgent({ kind: 'human', name: 'artist', version: '1' });
  const analyzer = await lab.service.registerAgent({
    kind: 'analyzer', name: 'physical-analyzer', version: '1.0.0' });
  const intent = await lab.service.createResearchIntent({
    question: 'discover a bass that breathes', agentId: artist.id });

  const TOTAL = 100;
  const DISTINCT_CONTENTS = 90; // 10 imports deliberately reuse earlier bytes
  let imported = 0;
  const materialIds: string[] = [];
  for (let i = 0; i < TOTAL; i++) {
    const seed = i < DISTINCT_CONTENTS ? i : i - DISTINCT_CONTENTS;
    const bytes = encodeWav(synthesize(seed, 8000, 1, 2000));
    const m = await lab.service.importMaterial({
      bytes, filename: `corpus-${String(i).padStart(3, '0')}.wav`, agentId: artist.id });
    materialIds.push(m.id); imported += 1;
    if (i % 10 === 0) await lab.service.analyzeMaterial(m.id, ANALYZER_V1, analyzer.id);
  }

  // A short derivation chain, so genealogy has real depth to traverse.
  let current = materialIds[0]!;
  for (let generation = 0; generation < 3; generation++) {
    const exp = await lab.service.createExperiment({
      researchIntentId: intent.id, inputMaterialIds: [current],
      operation: 'reverse', agentId: artist.id });
    const preview = await lab.service.runExperiment(exp.id);
    const retained = await lab.service.retain(preview, artist.id);
    if (generation === 2) await lab.service.reject(retained.material.id, artist.id, 'dead end');
    else await lab.service.promote(retained.material.id, artist.id);
    current = retained.material.id;
  }
  log(`seeded ${imported} imported materials + 3 derived generations`);
  await lab.close();
  await cmdStats();
}

async function count(lab: Awaited<ReturnType<typeof openLab>>, collection: string): Promise<number> {
  let total = 0; let after: string | null = null;
  for (;;) {
    const page = await lab.records.scan(collection, after, 500);
    total += page.items.length;
    if (page.nextAfter === null) break;
    after = String(page.nextAfter[0]);
  }
  return total;
}

async function cmdStats(): Promise<void> {
  const lab = await openLab(ROOT);
  const promoted = await collectAll(lab, LIFECYCLE.promoted);
  const retained = await collectAll(lab, LIFECYCLE.retained);
  const rejected = await collectAll(lab, LIFECYCLE.rejected);
  const dupes = await lab.queries.duplicateContentGroups();
  const hashes = new Set<string>();
  let materialCount = 0;
  let after: string | null = null;
  for (;;) {
    const page = await lab.records.scan(COLLECTIONS.entities, after, 500);
    for (const raw of page.items) {
      const e = raw as { role?: string; attributes?: { contentHash?: unknown } };
      if (e.role === 'material') {
        materialCount += 1;
        if (typeof e.attributes?.contentHash === 'string') hashes.add(e.attributes.contentHash);
      }
    }
    if (page.nextAfter === null) break;
    after = String(page.nextAfter[0]);
  }
  heading('scale statistics');
  log(`material entities:        ${materialCount}`);
  log(`unique content hashes:    ${hashes.size}`);
  log(`duplicate-content groups: ${dupes.size}`);
  log(`promoted:                 ${promoted}`);
  log(`retained:                 ${retained}`);
  log(`rejected:                 ${rejected}`);
  log(`observations:             ${await count(lab, COLLECTIONS.knowledge)}`);
  log(`relationships:            ${await count(lab, COLLECTIONS.relationships)}`);
  log(`transitions:              ${await count(lab, COLLECTIONS.transitions)}`);
  log(`agents:                   ${await count(lab, COLLECTIONS.agents)}`);
  await lab.close();
}

async function collectAll(lab: Awaited<ReturnType<typeof openLab>>, state: string): Promise<number> {
  let total = 0;
  let after: readonly (string | number | boolean | null)[] | undefined;
  for (;;) {
    const page = await lab.queries.materialsByLifecycle(state, after, 200);
    total += page.items.length;
    if (page.nextAfter === null) break;
    after = page.nextAfter;
  }
  return total;
}

async function cmdQueries(): Promise<void> {
  const lab = await openLab(ROOT);
  const inv = await lab.queries.promotedMaterials(undefined, 5);
  heading('Q1 promoted materials (canonical order)');
  for (const m of inv.items) log(`  ${m.id.slice(0, 8)}… ${String(m.attributes.filename ?? m.attributes.origin)}`);

  const anyMaterial = inv.items[0];
  if (anyMaterial) {
    heading('Q2 observations grouped by agent+version');
    for (const [g, l] of await lab.queries.observationsForMaterial(anyMaterial.id)) log(`  ${g}: ${l.length}`);
    heading('Q4 descendants');
    const d = await lab.queries.descendants(anyMaterial.id);
    log(`  ${d.nodes.length} descendant(s), cycles=${d.cyclesDetected.length}`);
  }
  heading('Q7 retained / rejected (excluded from Inventory)');
  log(`  retained=${(await lab.queries.materialsByLifecycle(LIFECYCLE.retained)).items.length}` +
      ` rejected=${(await lab.queries.materialsByLifecycle(LIFECYCLE.rejected)).items.length}`);
  heading('Q11 duplicate-content groups (never merged)');
  const groups = await lab.queries.duplicateContentGroups();
  log(`  ${groups.size} group(s); example sizes: ` +
      [...groups.values()].slice(0, 5).map((g) => g.length).join(', '));
  await lab.close();
}

async function cmdAudit(): Promise<void> {
  const lab = await openLab(ROOT);
  const r = await lab.queries.integrityAudit();
  heading('Q10 integrity audit (paginated full-corpus, non-interactive)');
  log(`dangling relationships:      ${r.danglingRelationships.length}`);
  log(`orphan knowledge:            ${r.orphanKnowledge.length}`);
  log(`materials missing content:   ${r.materialsWithMissingContent.length}`);
  log(`unreferenced content blobs:  ${r.unreferencedContentBlobs.length}`);
  await lab.close();
}

const command = process.argv[2] ?? 'demo';
const table: Record<string, () => Promise<void>> = {
  migrate: cmdMigrate, reset: cmdReset, demo: cmdDemo,
  seed: cmdSeed, stats: cmdStats, queries: cmdQueries, audit: cmdAudit,
};
const handler = table[command];
if (!handler) { console.error(`unknown command: ${command}`); process.exit(1); }
await handler();
