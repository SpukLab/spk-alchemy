import assert from 'node:assert/strict';
import test from 'node:test';
import { EXP_016_ID, exp016Checkpoint } from '../../src/domain/observatory/exp-016.ts';
import { FKC_BASELINE } from '../../src/domain/observatory/checkpoint-v1.ts';

test('EXP-2026-016 is closed with validated no-change synthesis', () => {
  assert.equal(exp016Checkpoint.experiment.id, EXP_016_ID);
  assert.equal(exp016Checkpoint.experiment.lifecycleState, 'closed');
  assert.equal(exp016Checkpoint.experiment.attributes.evidenceCompleteness, 'substantial');
  assert.equal(exp016Checkpoint.knowledge.stage, 'validated');
  assert.equal(exp016Checkpoint.knowledge.payload.state, 'CLOSED');
  assert.equal(exp016Checkpoint.knowledge.payload.verdict, 'NO CHANGE');
  assert.equal(exp016Checkpoint.knowledge.payload.constitutionalDelta, 'NONE');
});

test('EXP-2026-016 preserves the adversarial H1-H5 result without canon promotion', () => {
  const statuses = exp016Checkpoint.knowledge.payload.hypothesesFinalStatus as Record<string, string>;
  assert.deepEqual(statuses, {
    H1: 'WEAKENED',
    H2: 'FALSIFIED',
    H3: 'SURVIVES',
    H4: 'SURVIVES',
    H5: 'SURVIVES',
  });
  assert.notEqual(exp016Checkpoint.knowledge.stage, 'canon');
});

test('EXP-2026-016 remains bound to the exact FKC-000 v0.2 baseline', () => {
  const target = exp016Checkpoint.experiment.attributes.target as typeof FKC_BASELINE;
  assert.equal(target.id, 'FKC-000');
  assert.equal(target.version, '0.2');
  assert.equal(target.blobSha, 'd7fa6ff077b8d07aadb5f295d737f52d75d22dba');
});

test('EXP-2026-016 preserves provenance and open research after closure', () => {
  assert.equal(exp016Checkpoint.relationship.metadata.predecessor, 'EXP-2026-015');
  assert.equal(exp016Checkpoint.relationship.metadata.relation, 'adversarial-follow-up');
  assert.deepEqual(exp016Checkpoint.knowledge.payload.evidenceModels, ['Grok', 'Gemini', 'Claude', 'DeepSeek']);
  const openResearch = exp016Checkpoint.knowledge.payload.openResearch as string[];
  assert.equal(openResearch.some((item) => item.includes('Responsibility')), true);
  assert.equal(openResearch.some((item) => item.includes('Revocation')), true);
});
