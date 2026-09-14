import type { Entity, Knowledge, Relationship } from '../../core/primitives.ts';
import { FKC_BASELINE, observatoryRecoveryAgent, observatoryResearchIntent } from './checkpoint-v1.ts';
import { OBS_KNOWLEDGE_KIND, OBS_LIFECYCLE, OBS_REL, OBS_ROLE_RESEARCH, OBS_TYPE_EXPERIMENT } from './vocabulary.ts';

const CREATED_AT = Date.UTC(2026, 8, 14, 11, 50, 0);

export const EXP_016_ID = '06375b7f-a857-48b9-a459-1ef116200016';

export const exp016Entity: Entity = {
  id: EXP_016_ID,
  type: OBS_TYPE_EXPERIMENT,
  role: OBS_ROLE_RESEARCH,
  lifecycleState: OBS_LIFECYCLE.active,
  schemaVersion: 1,
  createdAt: CREATED_AT,
  attributes: {
    code: 'EXP-2026-016',
    title: 'Adversarial test of Principal, delegation, revocation and responsibility',
    target: FKC_BASELINE,
    evidenceCompleteness: 'none-yet',
    researchProtocol: 'docs/observatory/EXP-2026-016-PROMPT.md',
    purpose: 'Attempt to falsify the surviving governance hypotheses from EXP-2026-015 without presuming constitutional insufficiency.',
    hypothesesUnderAttack: [
      'Authority normally remains with the originating Principal while execution and bounded Permission delegate downstream.',
      'Responsibility follows Authority more strongly than execution.',
      'Conditional policy execution can be represented without delegated runtime decision authority.',
      'Revocation can be represented by EVENT/Transition and Provenance without a new governance concept.',
      'Cross-boundary governance does not require splitting CAN into multiple constitutional predicates.',
    ],
  },
};

export const exp016IntentRelationship: Relationship = {
  id: '7f2c5120-acde-4c31-93bb-160000000016',
  type: OBS_REL.investigatesIntent,
  source: EXP_016_ID,
  target: observatoryResearchIntent.id,
  agentId: observatoryRecoveryAgent.id,
  evidence: [],
  metadata: {
    predecessor: 'EXP-2026-015',
    relation: 'adversarial-follow-up',
  },
  schemaVersion: 1,
  createdAt: CREATED_AT,
};

export const exp016ResearchState: Knowledge = {
  id: '632d52dd-203f-4070-92e8-160000000016',
  subject: EXP_016_ID,
  subjectKind: 'entity',
  kind: OBS_KNOWLEDGE_KIND.researchState,
  stage: 'observation',
  payload: {
    state: 'ACTIVE',
    constitutionalBaseline: FKC_BASELINE,
    predecessor: 'EXP-2026-015',
    evidenceState: 'awaiting-independent-adversarial-responses',
    constitutionalDelta: 'NONE — no conclusion has been reached',
  },
  agentId: observatoryRecoveryAgent.id,
  agentVersion: '1',
  evidence: [],
  confidence: null,
  schemaVersion: 1,
  createdAt: CREATED_AT,
  supersedes: null,
};

export const exp016Checkpoint = {
  experiment: exp016Entity,
  relationship: exp016IntentRelationship,
  knowledge: exp016ResearchState,
} as const;
