import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteRecordStore } from '../../src/adapters/node-sqlite/record-store.ts';
import { FsContentStore } from '../../src/adapters/content-fs/content-store.ts';
import { DataRegistry } from '../../src/registries/data-registry.ts';
import { registerAlchemyVocabulary, KNOWLEDGE_KIND } from '../../src/domain/alchemy/vocabulary.ts';
import { AlchemyService } from '../../src/domain/alchemy/service.ts';
import { AlchemyQueries } from '../../src/query/queries.ts';
import { migrate, CURRENT_SCHEMA } from '../../src/migrations/index.ts';
import { synthesize, encodeWav } from '../../src/audio/wav.ts';
import { ANALYZER_V1 } from '../../src/audio/analyzer.ts';
import { COLLECTIONS } from '../../src/core/primitives.ts';

async function lab() {
  const dir = mkdtempSync(join(tmpdir(), 'spk-adr011-'));
  const records = new SqliteRecordStore(join(dir, 'store.sqlite'), CURRENT_SCHEMA);
  await migrate(records);
  const content = new FsContentStore(join(dir, 'content'));
  const data = new DataRegistry();
  registerAlchemyVocabulary(data);
  let clock = 10_000;
  const service = new AlchemyService(records, content, data, () => ++clock);
  const queries = new AlchemyQueries(records, content);
  const artist = await service.registerAgent({ kind: 'human', name: 'artist', version: '1' });
  const source = await service.importMaterial({
    bytes: encodeWav(synthesize(11, 8000, 1, 1200)),
    filename: 'source.wav',
    agentId: artist.id,
  });
  return { records, service, queries, artist, source };
}

test('ADR-011: durable epistemic standing does not imply institutional endorsement', async () => {
  const l = await lab();
  const record = await l.service.assertEpistemicRecord({
    subject: l.source.id,
    kind: KNOWLEDGE_KIND.curatedConclusion,
    epistemicStanding: 'hypothesis',
    payload: { note: 'candidate' },
    agentId: l.artist.id,
  });

  const promoted = await l.service.transitionKnowledgeEpistemicStanding(
    record.id, 'durable', l.artist.id, 'survived challenge');

  assert.equal(promoted.knowledge.id, record.id, 'epistemic transition preserves identity');
  assert.equal(promoted.knowledge.epistemicStanding, 'durable');
  assert.equal(promoted.knowledge.institutionalStanding, 'unendorsed');
  assert.equal(promoted.knowledge.stage, 'validated',
    'legacy scalar is only a compatibility projection');
  assert.equal((await l.queries.canonKnowledgeForSubject(l.source.id)).length, 0,
    'durable Knowledge is not silently Canon');

  const transitions = await l.queries.transitionsFor(record.id);
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0]!.kind, 'knowledge-epistemic-standing');
  assert.equal(transitions[0]!.context.dimension, 'epistemic');
  await l.records.close();
});

test('ADR-011: Canon can coexist with epistemic uncertainty', async () => {
  const l = await lab();
  const record = await l.service.assertEpistemicRecord({
    subject: l.source.id,
    kind: KNOWLEDGE_KIND.curatedConclusion,
    epistemicStanding: 'hypothesis',
    payload: { note: 'institutionally adopted before epistemic closure' },
    agentId: l.artist.id,
  });

  const endorsed = await l.service.setKnowledgeInstitutionalStanding(
    record.id, 'endorsed', l.artist.id, 'explicit institutional decision');

  assert.equal(endorsed.knowledge.id, record.id);
  assert.equal(endorsed.knowledge.epistemicStanding, 'hypothesis',
    'endorsement does not manufacture epistemic durability');
  assert.equal(endorsed.knowledge.institutionalStanding, 'endorsed');
  assert.equal(endorsed.knowledge.stage, 'canon',
    'legacy canon query remains available during migration');

  const canon = await l.queries.canonKnowledgeForSubject(l.source.id);
  assert.deepEqual(canon.map((k) => k.id), [record.id]);
  await l.records.close();
});

test('ADR-011: withdrawing endorsement preserves durable Knowledge and history', async () => {
  const l = await lab();
  const record = await l.service.assertEpistemicRecord({
    subject: l.source.id,
    kind: KNOWLEDGE_KIND.curatedConclusion,
    epistemicStanding: 'durable',
    institutionalStanding: 'endorsed',
    payload: { note: 'durable and endorsed' },
    agentId: l.artist.id,
  });

  const withdrawn = await l.service.setKnowledgeInstitutionalStanding(
    record.id, 'withdrawn', l.artist.id, 'policy changed');

  assert.equal(withdrawn.knowledge.id, record.id);
  assert.equal(withdrawn.knowledge.epistemicStanding, 'durable',
    'institutional withdrawal does not invalidate the proposition');
  assert.equal(withdrawn.knowledge.institutionalStanding, 'withdrawn');
  assert.equal(withdrawn.knowledge.stage, 'validated');
  assert.equal((await l.queries.canonKnowledgeForSubject(l.source.id)).length, 0);

  const transitions = await l.queries.transitionsFor(record.id);
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0]!.kind, 'knowledge-institutional-standing');
  assert.equal(transitions[0]!.fromState, 'endorsed');
  assert.equal(transitions[0]!.toState, 'withdrawn');
  await l.records.close();
});

test('ADR-011: epistemic and institutional transitions are independently auditable', async () => {
  const l = await lab();
  const record = await l.service.assertEpistemicRecord({
    subject: l.source.id,
    kind: KNOWLEDGE_KIND.curatedConclusion,
    epistemicStanding: 'hypothesis',
    payload: { note: 'multi-axis' },
    agentId: l.artist.id,
  });

  await l.service.transitionKnowledgeEpistemicStanding(
    record.id, 'validated', l.artist.id, 'evidence reviewed');
  await l.service.setKnowledgeInstitutionalStanding(
    record.id, 'endorsed', l.artist.id, 'institution accepted');
  const durable = await l.service.transitionKnowledgeEpistemicStanding(
    record.id, 'durable', l.artist.id, 'durability established');

  assert.equal(durable.knowledge.epistemicStanding, 'durable');
  assert.equal(durable.knowledge.institutionalStanding, 'endorsed');
  assert.equal(durable.knowledge.stage, 'canon');

  const transitions = await l.queries.transitionsFor(record.id);
  assert.deepEqual(
    transitions.map((t) => t.kind),
    [
      'knowledge-epistemic-standing',
      'knowledge-institutional-standing',
      'knowledge-epistemic-standing',
    ],
  );
  assert.deepEqual(
    transitions.map((t) => t.context.dimension),
    ['epistemic', 'institutional', 'epistemic'],
  );

  const all = await l.records.scan(COLLECTIONS.knowledge, null, 100);
  assert.equal(all.items.filter((r) => r.id === record.id).length, 1,
    'orthogonal state changes do not create replacement Knowledge identities');
  await l.records.close();
});

test('ADR-011: legacy stage=canon remains readable without inventing epistemic certainty', async () => {
  const l = await lab();
  const legacy = await l.service.assertKnowledge({
    subject: l.source.id,
    kind: KNOWLEDGE_KIND.curatedConclusion,
    stage: 'canon',
    payload: { note: 'legacy' },
    agentId: l.artist.id,
  });

  assert.equal(legacy.stage, 'canon');
  assert.equal(legacy.institutionalStanding, 'endorsed');
  assert.equal(legacy.epistemicStanding, 'unknown',
    'legacy canon cannot be backfilled as validated/durable without evidence');
  await l.records.close();
});


test('ADR-011: repeated standing edges remain distinct events after regression', async () => {
  const l = await lab();
  const record = await l.service.assertEpistemicRecord({
    subject: l.source.id,
    kind: KNOWLEDGE_KIND.curatedConclusion,
    epistemicStanding: 'hypothesis',
    payload: { note: 'repeatable transition history' },
    agentId: l.artist.id,
  });

  await l.service.transitionKnowledgeEpistemicStanding(
    record.id, 'validated', l.artist.id, 'first validation');
  await l.service.transitionKnowledgeEpistemicStanding(
    record.id, 'hypothesis', l.artist.id, 'new contradiction');
  await l.service.transitionKnowledgeEpistemicStanding(
    record.id, 'validated', l.artist.id, 'revalidated');

  const transitions = await l.queries.transitionsFor(record.id);
  assert.equal(transitions.length, 3);
  assert.deepEqual(
    transitions.map((t) => [t.fromState, t.toState]),
    [
      ['hypothesis', 'validated'],
      ['validated', 'hypothesis'],
      ['hypothesis', 'validated'],
    ],
    'a later legitimate transition must not be deduplicated against older history',
  );
  assert.equal(
    new Set(transitions.map((t) => t.idempotencyKey)).size,
    3,
    'each historical occurrence has distinct event identity',
  );
  await l.records.close();
});


test('ADR-011: institutional endorsement does not depend on legacy kind stage rules', async () => {
  const l = await lab();
  const analyzer = await l.service.registerAgent({
    kind: 'analyzer', name: 'physical-analyzer', version: '1.0.0',
  });
  const observation = await l.service.analyzeMaterial(
    l.source.id, ANALYZER_V1, analyzer.id);

  assert.equal(observation.epistemicStanding, 'observation');
  assert.equal(observation.institutionalStanding, 'unendorsed');

  // physicalAnalysis legacy allowedStages never included 'canon'. Endorsement
  // must still be possible because institutional standing is an independent axis.
  const endorsed = await l.service.setKnowledgeInstitutionalStanding(
    observation.id, 'endorsed', l.artist.id, 'institution accepts this observation');

  assert.equal(endorsed.knowledge.epistemicStanding, 'observation',
    'endorsement must not manufacture validated/durable standing');
  assert.equal(endorsed.knowledge.institutionalStanding, 'endorsed');
  assert.equal(endorsed.knowledge.stage, 'canon',
    'legacy stage may project canon without becoming the authority');

  const canon = await l.queries.canonKnowledgeForSubject(l.source.id);
  assert.ok(canon.some((k) => k.id === observation.id));

  await assert.rejects(
    () => l.service.transitionKnowledgeEpistemicStanding(
      observation.id, 'durable', l.artist.id, 'invalid maturity jump for this kind'),
    /epistemic standing durable not allowed/,
    'epistemic kind constraints remain enforced independently',
  );

  await l.records.close();
});
