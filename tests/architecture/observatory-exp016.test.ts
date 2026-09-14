import assert from 'node:assert/strict';
import test from 'node:test';
import { EXP_016_ID, exp016Checkpoint } from '../../src/domain/observatory/exp-016.ts';
import { FKC_BASELINE } from '../../src/domain/observatory/checkpoint-v1.ts';

test('EXP-2026-016 is active and has no synthesized constitutional conclusion', () => {
  assert.equal(exp016Checkpoint.experiment.id, EXP_016_ID);
  assert.equal(exp016Checkpoint.experiment.lifecycleState, 'active');
  assert.equal(exp016Checkpoint.knowledge.stage, 'observation');
  assert.equal(exp016Checkpoint.knowledge.payload.state, 'ACTIVE');
  assert.equal(exp016Checkpoint.knowledge.payload.constitutionalDelta, 'NONE — no conclusion has been reached');
});

test('EXP-2026-016 remains bound to the exact FKC-000 v0.2 baseline', () => {
  const target = exp016Checkpoint.experiment.attributes.target as typeof FKC_BASELINE;
  assert.equal(target.id, 'FKC-000');
  assert.equal(target.version, '0.2');
  assert.equal(target.blobSha, 'd7fa6ff077b8d07aadb5f295d737f52d75d22dba');
});

test('EXP-2026-016 is an adversarial follow-up to EXP-2026-015', () => {
  assert.equal(exp016Checkpoint.relationship.metadata.predecessor, 'EXP-2026-015');
  assert.equal(exp016Checkpoint.relationship.metadata.relation, 'adversarial-follow-up');
  assert.equal(exp016Checkpoint.knowledge.payload.evidenceState, 'awaiting-independent-adversarial-responses');
});
