import type { EpistemicStage } from '../core/primitives.ts';
import { DomainRuleError } from '../core/errors.ts';

/** Canonical data contracts. Domains extend these; they never replace them. */
export interface EntityTypeDefinition {
  type: string;
  role: string;
  lifecycleStates: readonly string[];
  initialState: string;
  allowedTransitions: Readonly<Record<string, readonly string[]>>;
  validate?: (attributes: Record<string, unknown>) => void;
}
export interface RelationshipTypeDefinition {
  type: string;
  sourceTypes: readonly string[] | '*';
  targetTypes: readonly string[] | '*';
}
export interface KnowledgeKindDefinition {
  kind: string;
  allowedStages: readonly EpistemicStage[];
  requiresConfidence?: boolean;
}

export class DataRegistry {
  readonly #entities = new Map<string, EntityTypeDefinition>();
  readonly #relationships = new Map<string, RelationshipTypeDefinition>();
  readonly #knowledge = new Map<string, KnowledgeKindDefinition>();
  readonly #roles = new Set<string>();

  registerEntityType(def: EntityTypeDefinition): void {
    if (this.#entities.has(def.type)) throw new DomainRuleError(`entity type already registered: ${def.type}`);
    this.#entities.set(def.type, def);
    this.#roles.add(def.role);
  }
  registerRelationshipType(def: RelationshipTypeDefinition): void {
    if (this.#relationships.has(def.type)) throw new DomainRuleError(`relationship type already registered: ${def.type}`);
    this.#relationships.set(def.type, def);
  }
  registerKnowledgeKind(def: KnowledgeKindDefinition): void {
    if (this.#knowledge.has(def.kind)) throw new DomainRuleError(`knowledge kind already registered: ${def.kind}`);
    this.#knowledge.set(def.kind, def);
  }

  entityType(type: string): EntityTypeDefinition {
    const d = this.#entities.get(type);
    if (!d) throw new DomainRuleError(`unregistered entity type: ${type}`);
    return d;
  }
  relationshipType(type: string): RelationshipTypeDefinition {
    const d = this.#relationships.get(type);
    if (!d) throw new DomainRuleError(`unregistered relationship type: ${type}`);
    return d;
  }
  knowledgeKind(kind: string): KnowledgeKindDefinition {
    const d = this.#knowledge.get(kind);
    if (!d) throw new DomainRuleError(`unregistered knowledge kind: ${kind}`);
    return d;
  }
  roles(): string[] { return [...this.#roles]; }

  assertTransitionAllowed(type: string, from: string, to: string): void {
    const def = this.entityType(type);
    const allowed = def.allowedTransitions[from] ?? [];
    if (!allowed.includes(to)) {
      throw new DomainRuleError(`lifecycle transition ${from} -> ${to} not allowed for ${type}`);
    }
  }
}
