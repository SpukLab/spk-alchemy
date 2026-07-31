/**
 * The five canonical structural primitives. Nothing else is a root structure.
 * Canonical types (Research Intent, Canonical Grouping, Published Artifact) are
 * built FROM these, never alongside them.
 */
export const COLLECTIONS = {
  entities: 'entities',
  relationships: 'relationships',
  knowledge: 'knowledge',
  transitions: 'transitions',
  agents: 'agents',
  meta: 'meta',
} as const;
export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/** Anything that exists and can carry knowledge. */
export interface Entity {
  id: string;
  type: string;
  role: string;
  lifecycleState: string;
  schemaVersion: number;
  createdAt: number;
  updatedAt?: number;
  /** Domain payload. The core never interprets this. */
  attributes: Record<string, Json>;
}

/** Reified assertion between two records. Never an anonymous array. */
export interface Relationship {
  id: string;
  type: string;
  source: string;
  target: string;
  agentId: string;
  evidence: string[];
  metadata: Record<string, Json>;
  schemaVersion: number;
  createdAt: number;
  updatedAt?: number;
}

export type EpistemicStage =
  | 'observation' | 'hypothesis' | 'validated' | 'canon' | 'deprecated';

/** A claim about a subject. Distinct from the subject's identity. */
export interface Knowledge {
  id: string;
  subject: string;
  subjectKind: 'entity' | 'relationship';
  kind: string;
  stage: EpistemicStage;
  payload: Record<string, Json>;
  agentId: string;
  agentVersion: string;
  evidence: string[];
  confidence: number | null;
  schemaVersion: number;
  createdAt: number;
  supersedes: string | null;
}

/** A recorded change of state. Carries provenance for every act. */
export interface Transition {
  id: string;
  subject: string;
  kind: string;
  fromState: string | null;
  toState: string | null;
  agentId: string;
  idempotencyKey: string;
  rationale: string | null;
  context: Record<string, Json>;
  schemaVersion: number;
  createdAt: number;
}

export type AgentKind =
  | 'human' | 'analyzer' | 'ai_model' | 'system_process' | 'external_source';

/** Provenance. No untyped author strings anywhere in the system. */
export interface Agent {
  id: string;
  kind: AgentKind;
  name: string;
  version: string;
  metadata: Record<string, Json>;
  status: 'active' | 'retired';
  schemaVersion: number;
  createdAt: number;
}

export type AnyRecord = Entity | Relationship | Knowledge | Transition | Agent
  | { id: string; [k: string]: unknown };
