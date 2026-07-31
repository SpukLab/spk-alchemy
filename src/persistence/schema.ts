import { COLLECTIONS } from '../core/primitives.ts';

/**
 * Index DECLARATIONS are portable and belong to migrations.
 * Index REPRESENTATION and maintenance belong to adapters and never appear
 * in the portable contract.
 */
export interface IndexDeclaration {
  name: string;
  collection: string;
  /** Dotted paths into the record. Missing values encode as null. */
  fields: readonly string[];
  unique?: boolean;
}

export interface SchemaDeclaration {
  version: number;
  collections: readonly string[];
  indexes: readonly IndexDeclaration[];
}

export const SCHEMA_V1: SchemaDeclaration = {
  version: 1,
  collections: Object.values(COLLECTIONS),
  indexes: [
    // Entities
    { name: 'ent_by_role_lifecycle', collection: COLLECTIONS.entities,
      fields: ['role', 'lifecycleState', 'createdAt', 'id'] },
    { name: 'ent_by_content_hash', collection: COLLECTIONS.entities,
      fields: ['attributes.contentHash', 'createdAt', 'id'] },
    { name: 'ent_by_type', collection: COLLECTIONS.entities,
      fields: ['type', 'createdAt', 'id'] },
    // Relationships (adjacency)
    { name: 'rel_by_source', collection: COLLECTIONS.relationships,
      fields: ['source', 'type', 'createdAt', 'id'] },
    { name: 'rel_by_target', collection: COLLECTIONS.relationships,
      fields: ['target', 'type', 'createdAt', 'id'] },
    // Knowledge
    { name: 'kno_by_subject_stage', collection: COLLECTIONS.knowledge,
      fields: ['subject', 'stage', 'createdAt', 'id'] },
    { name: 'kno_by_subject_kind_agent', collection: COLLECTIONS.knowledge,
      fields: ['subject', 'kind', 'agentId', 'agentVersion', 'createdAt', 'id'] },
    { name: 'kno_by_supersedes', collection: COLLECTIONS.knowledge,
      fields: ['supersedes', 'createdAt', 'id'] },
    // Transitions
    { name: 'tra_by_subject', collection: COLLECTIONS.transitions,
      fields: ['subject', 'createdAt', 'id'] },
    { name: 'tra_by_idempotency', collection: COLLECTIONS.transitions,
      fields: ['idempotencyKey'], unique: true },
    // Agents
    { name: 'agt_by_kind_name_version', collection: COLLECTIONS.agents,
      fields: ['kind', 'name', 'version'], unique: true },
  ],
};

export function indexesFor(schema: SchemaDeclaration, collection: string): IndexDeclaration[] {
  return schema.indexes.filter((i) => i.collection === collection);
}
