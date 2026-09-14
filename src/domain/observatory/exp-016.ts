import type { Entity, Knowledge, Relationship } from '../../core/primitives.ts';
import { FKC_BASELINE, observatoryRecoveryAgent, observatoryResearchIntent } from './checkpoint-v1.ts';
import { OBS_KNOWLEDGE_KIND, OBS_LIFECYCLE, OBS_REL, OBS_ROLE_RESEARCH, OBS_TYPE_EXPERIMENT } from './vocabulary.ts';

const CREATED_AT = Date.UTC(2026, 8, 14, 11, 50, 0);

export const EXP_016_ID = '06375b7f-a857-48b9-a459-1ef116200016';

export const exp016Entity: Entity = {
  id: EXP_016_ID,
  type: OBS_TYPE_EXPERIMENT,
  role: OBS_ROLE_RESEARCH,
  lifecycleState: OBS_LIFECYCLE.closed,
  schemaVersion: 1,
  createdAt: CREATED_AT,
  attributes: {
    code: 'EXP-2026-016',
    title: 'Adversarial test of Principal, delegation, revocation and responsibility',
    target: FKC_BASELINE,
    evidenceCompleteness: 'substantial',
    researchProtocol: 'docs/observatory/EXP-2026-016-PROMPT.md',
    synthesisDocument: 'docs/observatory/EXP-2026-016-SYNTHESIS.md',
    purpose: 'Attempt to falsify the surviving governance hypotheses from EXP-2026-015 without presuming constitutional insufficiency.',
    evidenceModels: ['Grok', 'Gemini', 'Claude', 'DeepSeek'],
    hypothesesFinalStatus: {
      H1: 'WEAKENED',
      H2: 'FALSIFIED',
      H3: 'SURVIVES',
      H4: 'SURVIVES',
      H5: 'SURVIVES',
    },
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
  stage: 'validated',
  payload: {
    state: 'CLOSED',
    verdict: 'NO CHANGE',
    constitutionalImpact: 'NO_CHANGE',
    constitutionalBaseline: FKC_BASELINE,
    predecessor: 'EXP-2026-015',
    evidenceState: 'independent-adversarial-synthesis-complete',
    evidenceModels: ['Grok', 'Gemini', 'Claude', 'DeepSeek'],
    synthesisDocument: 'docs/observatory/EXP-2026-016-SYNTHESIS.md',
    hypothesesFinalStatus: {
      H1: 'WEAKENED',
      H2: 'FALSIFIED',
      H3: 'SURVIVES',
      H4: 'SURVIVES',
      H5: 'SURVIVES',
    },
    constitutionalDelta: 'NONE',
    openResearch: [
      'Principal ontology and legitimacy',
      'Authority transfer versus delegation and multi-hop subdelegation',
      'Concurrent independently-originated Authority',
      'Revocation cascade, expiry, rollback and in-flight semantics',
      'Responsibility attribution, sharing, transfer, retention and foreseeability',
      'Standing-policy re-evaluation after contradictory operational evidence',
    ],
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
