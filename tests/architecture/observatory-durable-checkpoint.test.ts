import assert from 'node:assert/strict';
import test from 'node:test';
import { DataRegistry } from '../../src/registries/data-registry.ts';
import { registerObservatoryVocabulary, OBS_KNOWLEDGE_KIND, OBS_TYPE_EXPERIMENT } from '../../src/domain/observatory/vocabulary.ts';
import { observatoryCheckpointV1, FKC_BASELINE } from '../../src/domain/observatory/checkpoint-v1.ts';

test('Observatory vocabulary extends the shared substrate without new structural primitives', () => {
  const registry = new DataRegistry();
  registerObservatoryVocabulary(registry);
  assert.equal(registry.entityType(OBS_TYPE_EXPERIMENT).role, 'observatory-research');
  assert.deepEqual(registry.knowledgeKind(OBS_KNOWLEDGE_KIND.experimentSynthesis).allowedStages,
    ['hypothesis', 'validated', 'deprecated']);
});

test('checkpoint preserves historical uncertainty and leaves EXP-015 active', () => {
  assert.equal(FKC_BASELINE.version, '0.2');
  assert.equal(observatoryCheckpointV1.experiments.length, 9);
  const active = observatoryCheckpointV1.experiments.filter((e) => e.lifecycleState === 'active');
  assert.equal(active.length, 1);
  assert.equal(active[0]?.attributes.code, 'EXP-2026-015');
  assert.equal(observatoryCheckpointV1.knowledge.some((k) => k.stage === 'canon'), false);
  assert.equal(observatoryCheckpointV1.experiments.some((e) => e.attributes.evidenceCompleteness === 'partial'), true);
});
