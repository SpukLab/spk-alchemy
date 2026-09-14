import type { Agent, Entity, Knowledge, Relationship } from '../../core/primitives.ts';
import { OBS_KNOWLEDGE_KIND, OBS_LIFECYCLE, OBS_REL, OBS_TYPE_EXPERIMENT, OBS_TYPE_RESEARCH_INTENT, OBS_ROLE_RESEARCH } from './vocabulary.ts';

export const OBSERVATORY_CHECKPOINT_VERSION = '1';
export const FKC_BASELINE = {
  id: 'FKC-000',
  version: '0.2',
  status: 'CANDIDATE',
  blobSha: 'd7fa6ff077b8d07aadb5f295d737f52d75d22dba',
} as const;

const CREATED_AT = Date.UTC(2026, 8, 13, 0, 0, 0);

export const observatoryRecoveryAgent: Agent = {
  id: '0559d6aa-ca5e-475b-964c-791255c330a5',
  kind: 'system_process',
  name: 'observatory-recovery',
  version: OBSERVATORY_CHECKPOINT_VERSION,
  metadata: { source: 'historical-synthesis', evidenceCompleteness: 'partial' },
  status: 'active',
  schemaVersion: 1,
  createdAt: CREATED_AT,
};

export const observatoryResearchIntent: Entity = {
  id: '5c1ab779-f282-43b2-a260-67f49c145953',
  type: OBS_TYPE_RESEARCH_INTENT,
  role: OBS_ROLE_RESEARCH,
  lifecycleState: 'active',
  schemaVersion: 1,
  createdAt: CREATED_AT,
  attributes: {
    title: 'Adversarial constitutional verification of FKC-000 v0.2',
    baseline: FKC_BASELINE,
  },
};

type HistoricalExperiment = {
  code: string;
  id: string;
  title: string;
  lifecycle: string;
  verdict: string;
  completeness: 'partial' | 'substantial';
};

export const historicalExperiments: readonly HistoricalExperiment[] = [
  { code: 'EXP-2026-007', id: 'd1588948-6ed4-41df-a9fd-57050e7308be', title: 'Applicability and scope elimination', lifecycle: OBS_LIFECYCLE.closed, verdict: 'APPLICABILITY not supported as primitive; scope/context/domain remain derived.', completeness: 'partial' },
  { code: 'EXP-2026-008', id: '864d47d0-ca65-400e-9b01-0e6106cc4ba4', title: 'Reality, representation, belief and decision', lifecycle: OBS_LIFECYCLE.closed, verdict: 'STATE != BELIEF; REPRESENTATION != BELIEF; INFERENCE != DECISION; DECISION != COMMITMENT.', completeness: 'partial' },
  { code: 'EXP-2026-009', id: '9df8184c-3fb0-4807-b44a-378114465a4b', title: 'Epistemic substrate', lifecycle: OBS_LIFECYCLE.closed, verdict: 'Representation/belief/model distinctions reinforced; no constitutional change established.', completeness: 'partial' },
  { code: 'EXP-2026-010', id: 'efcf2b0c-0bd6-4932-b4b5-8b41f486f7c8', title: 'Representation, content and epistemic relation', lifecycle: OBS_LIFECYCLE.closed, verdict: 'Storage/representation remain distinct from belief; primitive status unresolved.', completeness: 'partial' },
  { code: 'EXP-2026-011', id: '6262fe0b-c7bd-4590-9c56-aae8ceaa503c', title: 'Actor, bearer, role and relation', lifecycle: OBS_LIFECYCLE.closed, verdict: 'Generic HOLDS rejected; ACTOR not proven primitive; commitment/authority distinctions reinforced.', completeness: 'partial' },
  { code: 'EXP-2026-012', id: '97e11fec-4ea5-4d60-a916-2a3253cac32e', title: 'Constitutional delta map', lifecycle: OBS_LIFECYCLE.closed, verdict: 'DERIVABLE != CONSTITUTIONALLY DISPENSABLE; targeted direct verification required.', completeness: 'partial' },
  { code: 'EXP-2026-013', id: '089a7356-3048-4e25-8192-945ae8082a54', title: 'Direct constitutional verification of FKC-000', lifecycle: OBS_LIFECYCLE.closed, verdict: 'TARGETED CLARIFICATION; primitive ontology frozen; inference question isolated for further test.', completeness: 'substantial' },
  { code: 'EXP-2026-014', id: 'e5febaa8-cdfb-465b-a9e8-816074aaa9c4', title: 'Inference elimination test', lifecycle: OBS_LIFECYCLE.closed, verdict: 'NO CHANGE. Inferential validity is diagnosable without a named constitutional function.', completeness: 'substantial' },
  { code: 'EXP-2026-015', id: '52fba64f-73f7-48bc-aaff-f837207471a0', title: 'Operational validation of authority, permission and delegation', lifecycle: OBS_LIFECYCLE.closed, verdict: 'NO CHANGE. Governance grammar represents all tested cases; delegation/revocation/Principal mechanics remain open; responsibility distribution added as open-research candidate.', completeness: 'substantial' },
] as const;

export const observatoryExperimentEntities: Entity[] = historicalExperiments.map((exp) => ({
  id: exp.id,
  type: OBS_TYPE_EXPERIMENT,
  role: OBS_ROLE_RESEARCH,
  lifecycleState: exp.lifecycle,
  schemaVersion: 1,
  createdAt: CREATED_AT,
  attributes: {
    code: exp.code,
    title: exp.title,
    target: FKC_BASELINE,
    evidenceCompleteness: exp.completeness,
    reconstructionSource: 'historical-synthesis',
  },
}));

const RELATIONSHIP_IDS = [
  '86a0fab1-8c5a-4455-ba52-e4a5781f1419',
  'f3ea4235-144f-474a-889a-a9ea6b50be49',
  'c2903a8a-a791-4e57-ad57-55b9e6946121',
  '2b93dd6c-7f57-4e74-a5d6-04afb913b698',
  '0f030499-8cfc-40c7-9bdd-1b82899469d9',
  'd33b400e-03f4-4bb2-824e-64980715782e',
  '2dd252ce-9317-4f54-a9da-66f45c4fe1a1',
  'cb5cab6b-32f8-4493-a12d-e76c85317806',
  '8489368e-88e5-43db-8624-3d7d1b8be699'
] as const;

const KNOWLEDGE_IDS = [
  'c69490b3-49df-4f10-836f-bb4b3a6c1bc8',
  '5b387af6-9843-41f8-8bcf-ca0a58db2094',
  '9c6d6789-4609-46d4-a944-64b327742766',
  '66cf6a56-12ee-4105-b492-cc48b9787e4b',
  '04c16b0f-2105-45a4-aa56-e01af336ffd9',
  '576ccb5d-c210-4775-887e-7fee04ea5cb8',
  '93000aa8-ded3-42c5-a1c7-6a217f6dd400',
  'c254e609-8db6-4b51-bb95-2130fe6d0b45',
  'd9be6f59-a31b-4dcb-99fb-c2722fffeba4'
] as const;

export const observatoryIntentRelationships: Relationship[] = historicalExperiments.map((exp, index) => ({
  id: RELATIONSHIP_IDS[index]!,
  type: OBS_REL.investigatesIntent,
  source: exp.id,
  target: observatoryResearchIntent.id,
  agentId: observatoryRecoveryAgent.id,
  evidence: [],
  metadata: {},
  schemaVersion: 1,
  createdAt: CREATED_AT + index,
}));

export const observatorySynthesisKnowledge: Knowledge[] = historicalExperiments.map((exp, index) => ({
  id: KNOWLEDGE_IDS[index]!,
  subject: exp.id,
  subjectKind: 'entity',
  kind: OBS_KNOWLEDGE_KIND.experimentSynthesis,
  stage: 'validated',
  payload: {
    verdict: exp.verdict,
    evidenceCompleteness: exp.completeness,
    reconstructionSource: exp.code === 'EXP-2026-015' ? 'independent-model-synthesis' : 'historical-synthesis',
    constitutionalBaseline: FKC_BASELINE,
    ...(exp.code === 'EXP-2026-015' ? {
      evidenceModels: ['Grok', 'DeepSeek', 'Claude', 'Gemini'],
      synthesisDocument: 'docs/observatory/EXP-2026-015-SYNTHESIS.md',
      constitutionalImpact: 'NO_CHANGE',
      openResearchCandidate: 'responsibility transfer/sharing/retention across delegation chains',
    } : {}),
  },
  agentId: observatoryRecoveryAgent.id,
  agentVersion: OBSERVATORY_CHECKPOINT_VERSION,
  evidence: [],
  confidence: null,
  schemaVersion: 1,
  createdAt: CREATED_AT + index,
  supersedes: null,
}));

export const observatoryCheckpointV1 = {
  agent: observatoryRecoveryAgent,
  intent: observatoryResearchIntent,
  experiments: observatoryExperimentEntities,
  relationships: observatoryIntentRelationships,
  knowledge: observatorySynthesisKnowledge,
} as const;
