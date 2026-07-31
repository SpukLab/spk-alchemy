import type { RecordStore, Page } from '../persistence/record-store.ts';
import type { ContentStore } from '../persistence/content-store.ts';
import type { Entity, Knowledge, Relationship, Transition } from '../core/primitives.ts';
import { COLLECTIONS } from '../core/primitives.ts';
import { traverse } from './traversal.ts';
import type { TraversalResult } from './traversal.ts';
import { LIFECYCLE, REL, KNOWLEDGE_KIND, ROLE_MATERIAL } from '../domain/alchemy/vocabulary.ts';
import type { KeyTuple } from '../persistence/keys.ts';

/**
 * Ordering contract per query. "canonical" means the declared key order is
 * semantically meaningful; "set" means callers and tests must normalize.
 */
export const QUERY_ORDERING = {
  promotedMaterials: 'canonical',
  observationsForMaterial: 'canonical-within-group',
  ancestors: 'depth-then-canonical',
  descendants: 'depth-then-canonical',
  experimentsForIntent: 'canonical',
  experimentInputsOutputs: 'set',
  materialsByLifecycle: 'canonical',
  compareAnalyzerVersions: 'set',
  canonKnowledgeForSubject: 'canonical',
  integrityAudit: 'set',
  duplicateContentGroups: 'canonical-within-group',
} as const;

export class AlchemyQueries {
  readonly #records: RecordStore;
  readonly #content: ContentStore;
  constructor(records: RecordStore, content: ContentStore) {
    this.#records = records; this.#content = content;
  }

  /** Q1. Default Inventory: role = material AND lifecycleState = promoted. */
  async promotedMaterials(after?: KeyTuple, limit = 50): Promise<Page<Entity>> {
    const page = await this.#records.lookup({
      collection: COLLECTIONS.entities, index: 'ent_by_role_lifecycle',
      prefix: [ROLE_MATERIAL, LIFECYCLE.promoted], after, limit,
    });
    return { items: page.items as unknown as Entity[], nextAfter: page.nextAfter };
  }

  /** Q7. Retained and rejected materials, deliberately outside the Inventory. */
  async materialsByLifecycle(state: string, after?: KeyTuple, limit = 50): Promise<Page<Entity>> {
    const page = await this.#records.lookup({
      collection: COLLECTIONS.entities, index: 'ent_by_role_lifecycle',
      prefix: [ROLE_MATERIAL, state], after, limit,
    });
    return { items: page.items as unknown as Entity[], nextAfter: page.nextAfter };
  }

  /** Q2. Observations for one material, grouped by Agent and Agent version. */
  async observationsForMaterial(
    materialId: string,
  ): Promise<Map<string, Knowledge[]>> {
    const out = new Map<string, Knowledge[]>();
    let after: KeyTuple | undefined;
    for (;;) {
      const page = await this.#records.lookup({
        collection: COLLECTIONS.knowledge, index: 'kno_by_subject_kind_agent',
        prefix: [materialId, KNOWLEDGE_KIND.physicalAnalysis], after, limit: 100,
      });
      for (const raw of page.items) {
        const k = raw as unknown as Knowledge;
        const groupKey = `${k.agentId}@${k.agentVersion}`;
        const bucket = out.get(groupKey) ?? [];
        bucket.push(k); out.set(groupKey, bucket);
      }
      if (page.nextAfter === null) break;
      after = page.nextAfter;
    }
    return out;
  }

  /** Q3. */
  ancestors(materialId: string, maxDepth?: number): Promise<TraversalResult> {
    return traverse(this.#records, materialId, {
      relationshipType: REL.derivedFrom, direction: 'ancestors', maxDepth,
    });
  }

  /** Q4. */
  descendants(materialId: string, maxDepth?: number): Promise<TraversalResult> {
    return traverse(this.#records, materialId, {
      relationshipType: REL.derivedFrom, direction: 'descendants', maxDepth,
    });
  }

  /** Q5. */
  async experimentsForIntent(intentId: string): Promise<Entity[]> {
    const page = await this.#records.adjacencyByTarget({
      nodeId: intentId, type: REL.investigatesIntent, limit: 200,
    });
    const ids = page.items.map((r) => (r as unknown as Relationship).source);
    const rows = await this.#records.getMany(COLLECTIONS.entities, ids);
    return rows.filter((r) => r !== null) as unknown as Entity[];
  }

  /** Q6. */
  async experimentInputsOutputs(
    experimentId: string,
  ): Promise<{ inputs: Entity[]; outputs: Entity[] }> {
    const incoming = await this.#records.adjacencyByTarget({
      nodeId: experimentId, limit: 200,
    });
    const inputIds: string[] = []; const outputIds: string[] = [];
    for (const raw of incoming.items) {
      const rel = raw as unknown as Relationship;
      if (rel.type === REL.inputTo) inputIds.push(rel.source);
      if (rel.type === REL.outputOf) outputIds.push(rel.source);
    }
    const [inputs, outputs] = await Promise.all([
      this.#records.getMany(COLLECTIONS.entities, inputIds),
      this.#records.getMany(COLLECTIONS.entities, outputIds),
    ]);
    return {
      inputs: inputs.filter((r) => r !== null) as unknown as Entity[],
      outputs: outputs.filter((r) => r !== null) as unknown as Entity[],
    };
  }

  /** Q8. Compare two analyzer versions without mutating either result. */
  async compareAnalyzerVersions(
    materialId: string, versionA: string, versionB: string,
  ): Promise<{ metric: string; a: number | null; b: number | null; equal: boolean }[]> {
    const grouped = await this.observationsForMaterial(materialId);
    const pick = (version: string): Knowledge | null => {
      for (const [key, list] of grouped) {
        if (key.endsWith(`@${version}`) && list.length > 0) {
          return [...list].sort((x, y) => y.createdAt - x.createdAt)[0]!;
        }
      }
      return null;
    };
    const a = pick(versionA); const b = pick(versionB);
    const metrics = new Set<string>([
      ...Object.keys(a?.payload ?? {}), ...Object.keys(b?.payload ?? {}),
    ]);
    return [...metrics].sort().map((metric) => {
      const av = typeof a?.payload[metric] === 'number' ? (a.payload[metric] as number) : null;
      const bv = typeof b?.payload[metric] === 'number' ? (b.payload[metric] as number) : null;
      return { metric, a: av, b: bv, equal: av === bv };
    });
  }

  /** Q9. Canon is a view over Knowledge, never a separate store. */
  async canonKnowledgeForSubject(subjectId: string, limit = 100): Promise<Knowledge[]> {
    const page = await this.#records.lookup({
      collection: COLLECTIONS.knowledge, index: 'kno_by_subject_stage',
      prefix: [subjectId, 'canon'], limit,
    });
    return page.items as unknown as Knowledge[];
  }

  /**
   * Q10. Integrity audit. Deliberately a paginated full-corpus operation: no
   * index can answer "which references are broken", and pretending otherwise
   * would be dishonest. Never on an interactive path.
   */
  async integrityAudit(): Promise<{
    danglingRelationships: string[];
    orphanKnowledge: string[];
    materialsWithMissingContent: string[];
    unreferencedContentBlobs: string[];
  }> {
    const entityIds = new Set<string>();
    const referencedHashes = new Set<string>();
    const materialsWithMissingContent: string[] = [];

    for await (const rec of this.#scanAll(COLLECTIONS.entities)) {
      const e = rec as unknown as Entity;
      entityIds.add(e.id);
      const hash = e.attributes?.contentHash;
      if (typeof hash === 'string') {
        referencedHashes.add(hash);
        if (!(await this.#content.has(hash))) materialsWithMissingContent.push(e.id);
      }
    }
    const danglingRelationships: string[] = [];
    for await (const rec of this.#scanAll(COLLECTIONS.relationships)) {
      const r = rec as unknown as Relationship;
      if (!entityIds.has(r.source) || !entityIds.has(r.target)) danglingRelationships.push(r.id);
    }
    const orphanKnowledge: string[] = [];
    for await (const rec of this.#scanAll(COLLECTIONS.knowledge)) {
      const k = rec as unknown as Knowledge;
      if (k.subjectKind === 'entity' && !entityIds.has(k.subject)) orphanKnowledge.push(k.id);
    }
    const unreferencedContentBlobs = (await this.#content.list())
      .filter((h) => !referencedHashes.has(h));

    return {
      danglingRelationships, orphanKnowledge,
      materialsWithMissingContent, unreferencedContentBlobs,
    };
  }

  /** Q11. Distinct entities sharing content, reported and never merged. */
  async duplicateContentGroups(): Promise<Map<string, string[]>> {
    const groups = new Map<string, string[]>();
    let after: KeyTuple | undefined;
    for (;;) {
      const page = await this.#records.lookup({
        collection: COLLECTIONS.entities, index: 'ent_by_content_hash',
        range: {}, after, limit: 200,
      });
      for (const raw of page.items) {
        const e = raw as unknown as Entity;
        const hash = e.attributes?.contentHash;
        if (typeof hash !== 'string') continue;
        const bucket = groups.get(hash) ?? [];
        bucket.push(e.id); groups.set(hash, bucket);
      }
      if (page.nextAfter === null) break;
      after = page.nextAfter;
    }
    for (const [hash, ids] of groups) if (ids.length < 2) groups.delete(hash);
    return groups;
  }

  async transitionsFor(subjectId: string): Promise<Transition[]> {
    const page = await this.#records.lookup({
      collection: COLLECTIONS.transitions, index: 'tra_by_subject',
      prefix: [subjectId], limit: 100,
    });
    return page.items as unknown as Transition[];
  }

  async *#scanAll(collection: string): AsyncGenerator<{ id: string }> {
    let after: string | null = null;
    for (;;) {
      const page: Page<{ id: string }> =
        await this.#records.scan(collection, after, 200) as Page<{ id: string }>;
      for (const item of page.items) yield item;
      if (page.nextAfter === null) break;
      after = String(page.nextAfter[0]);
    }
  }
}
