import type { RecordStore, Mutation } from '../../persistence/record-store.ts';
import type { ContentStore } from '../../persistence/content-store.ts';
import type { DataRegistry } from '../../registries/data-registry.ts';
import type { Agent, Entity, Relationship, Transition, Json } from '../../core/primitives.ts';
import { COLLECTIONS } from '../../core/primitives.ts';
import { newUuid, idempotencyKey } from '../../core/ids.ts';
import { DomainRuleError, NotFoundError, IntegrityError } from '../../core/errors.ts';
import {
  TYPE_FAMILY, TYPE_DNA_PACK, ROLE_GROUPING, ROLE_PUBLICATION, ROLE_MATERIAL,
  REL, TRANSITION_KIND, LIFECYCLE,
} from './vocabulary.ts';
import { decodeWav } from '../../audio/wav.ts';

const SCHEMA_VERSION = 1;

/**
 * FamilyService — Alchemy domain vocabulary over the canonical primitives.
 *
 * Family -> Canonical Grouping. DNA Pack -> Published Artifact. Neither is a
 * new structural primitive: a Family is an Entity plus reified `grouped_in`
 * membership Relationships; a DNA Pack is an Entity plus a `published_from`
 * Relationship to its source Family, `packaged_material` Relationships to
 * each exported member, and one immutable `publish` Transition.
 *
 * Deliberately a separate class from AlchemyService, constructed the same
 * way against the same (records, content, registry) — a new capability gets
 * a new focused unit rather than growing the tested one.
 */

export interface FamilyMember {
  materialId: string;
  order: number;
  relationshipId: string;
}

export interface DnaPackMemberSnapshot {
  order: number;
  materialId: string;
  filename: string;
  contentHash: string;
  durationSeconds: number;
  sampleRate: number;
  channels: number;
  origin: string;
  configurationId: string | null;
  configurationVersion: string | null;
  seed: number | null;
}

export interface DnaPackManifest {
  schemaVersion: number;
  packId: string;
  packVersion: number;
  familyId: string;
  familyRevision: number;
  familyName: string;
  publishedAt: number;
  publishingAgentId: string;
  members: DnaPackMemberSnapshot[];
}

export interface PublishedDnaPack {
  pack: Entity;
  manifest: DnaPackManifest;
}

export class FamilyService {
  readonly #records: RecordStore;
  readonly #content: ContentStore;
  readonly #registry: DataRegistry;
  #clock: () => number;

  constructor(records: RecordStore, content: ContentStore, registry: DataRegistry,
              clock: () => number = () => Date.now()) {
    this.#records = records; this.#content = content;
    this.#registry = registry; this.#clock = clock;
  }

  // ---- Family ---------------------------------------------------------------

  /** Only promoted Materials are default candidates; see MATERIAL ELIGIBILITY. */
  async createFamily(input: {
    name: string; note?: string; tags?: readonly string[];
    materialIds: readonly string[]; agentId: string;
  }): Promise<Entity> {
    await this.#requireAgent(input.agentId);
    const materials = await this.#requireEligibleMaterials(input.materialIds);
    const now = this.#clock();
    const family: Entity = {
      id: newUuid(), type: TYPE_FAMILY, role: ROLE_GROUPING,
      lifecycleState: LIFECYCLE.active ?? 'active',
      schemaVersion: SCHEMA_VERSION, createdAt: now,
      attributes: {
        name: input.name, note: input.note ?? null,
        tags: (input.tags ?? []) as Json, revision: 1,
      },
    };
    this.#registry.entityType(family.type).validate?.(family.attributes);

    const transition: Transition = {
      id: newUuid(), subject: family.id, kind: TRANSITION_KIND.familyCreate,
      fromState: null, toState: 'active', agentId: input.agentId,
      idempotencyKey: idempotencyKey('family-create', family.id),
      rationale: null, context: { materialCount: materials.length },
      schemaVersion: SCHEMA_VERSION, createdAt: now,
    };
    const mutations: Mutation[] = [
      { op: 'put', collection: COLLECTIONS.entities, record: family as never },
      { op: 'put', collection: COLLECTIONS.transitions, record: transition as never },
    ];
    materials.forEach((material, index) => {
      mutations.push({ op: 'put', collection: COLLECTIONS.relationships,
        record: this.#membership(material.id, family.id, index, input.agentId, now) as never });
    });
    await this.#records.commit(mutations);
    return family;
  }

  async listFamilies(): Promise<Entity[]> {
    const page = await this.#records.lookup({
      collection: COLLECTIONS.entities, index: 'ent_by_role_lifecycle',
      prefix: [ROLE_GROUPING, 'active'], limit: 200,
    });
    return [...(page.items as unknown as Entity[])].reverse();
  }

  async getFamily(familyId: string): Promise<Entity> {
    return this.#requireEntity(familyId, TYPE_FAMILY);
  }

  /** Ordered members, sorted client-side: family sizes are small by design. */
  async listMembers(familyId: string): Promise<FamilyMember[]> {
    const page = await this.#records.adjacencyByTarget({
      nodeId: familyId, type: REL.groupedIn, limit: 500,
    });
    const members = (page.items as unknown as Relationship[]).map((rel) => ({
      materialId: rel.source, order: Number(rel.metadata.order ?? 0), relationshipId: rel.id,
    }));
    members.sort((a, b) => a.order - b.order);
    return members;
  }

  /** Adding a member preserves Family identity: the Family Entity's id never changes. */
  async addMember(familyId: string, materialId: string, agentId: string): Promise<void> {
    await this.#requireAgent(agentId);
    const family = await this.#requireEntity(familyId, TYPE_FAMILY);
    const [material] = await this.#requireEligibleMaterials([materialId]);
    const members = await this.listMembers(familyId);
    if (members.some((m) => m.materialId === material!.id)) {
      throw new DomainRuleError(`material ${material!.id} is already a member of family ${familyId}`);
    }
    const now = this.#clock();
    const nextOrder = members.length === 0 ? 0 : Math.max(...members.map((m) => m.order)) + 1;
    await this.#records.commit([
      { op: 'put', collection: COLLECTIONS.relationships,
        record: this.#membership(material!.id, familyId, nextOrder, agentId, now) as never },
      { op: 'put', collection: COLLECTIONS.entities,
        record: this.#bumpRevision(family, now) as never },
    ]);
  }

  /** Removing a member preserves Family identity: only the membership Relationship is deleted. */
  async removeMember(familyId: string, materialId: string, agentId: string): Promise<void> {
    await this.#requireAgent(agentId);
    const family = await this.#requireEntity(familyId, TYPE_FAMILY);
    const members = await this.listMembers(familyId);
    const target = members.find((m) => m.materialId === materialId);
    if (!target) throw new NotFoundError('family-member', `${familyId}/${materialId}`);
    const now = this.#clock();
    await this.#records.commit([
      { op: 'delete', collection: COLLECTIONS.relationships, id: target.relationshipId },
      { op: 'put', collection: COLLECTIONS.entities,
        record: this.#bumpRevision(family, now) as never },
    ]);
  }

  /** Reordering preserves Family identity: existing Relationships are re-put with a new order only. */
  async reorderMembers(familyId: string, orderedMaterialIds: readonly string[], agentId: string): Promise<void> {
    await this.#requireAgent(agentId);
    const family = await this.#requireEntity(familyId, TYPE_FAMILY);
    const members = await this.listMembers(familyId);
    const byMaterial = new Map(members.map((m) => [m.materialId, m]));
    if (orderedMaterialIds.length !== members.length
        || !orderedMaterialIds.every((id) => byMaterial.has(id))) {
      throw new DomainRuleError('reorder must include exactly the family\'s current members, once each');
    }
    const now = this.#clock();
    const mutations: Mutation[] = [];
    orderedMaterialIds.forEach((materialId, index) => {
      const member = byMaterial.get(materialId)!;
      if (member.order === index) return; // no-op for members already in place
      mutations.push({ op: 'put', collection: COLLECTIONS.relationships,
        record: this.#membership(materialId, familyId, index, agentId, now, member.relationshipId) as never });
    });
    if (mutations.length === 0) return; // already in the requested order
    mutations.push({ op: 'put', collection: COLLECTIONS.entities,
      record: this.#bumpRevision(family, now) as never });
    await this.#records.commit(mutations);
  }

  // ---- DNA Pack ---------------------------------------------------------------

  /**
   * Publishing snapshots the Family's current membership and ordering into an
   * immutable Entity. It never mutates the Family. Republishing after the
   * Family changes creates a new, higher pack version; the previous pack's
   * Entity, Relationships and Transition are untouched.
   */
  async publish(familyId: string, agentId: string): Promise<PublishedDnaPack> {
    const agent = await this.#requireAgent(agentId);
    const family = await this.#requireEntity(familyId, TYPE_FAMILY);
    const members = await this.listMembers(familyId);
    if (members.length === 0) {
      throw new DomainRuleError(`family ${familyId} has no members to publish`);
    }

    const existingPacks = await this.#records.adjacencyByTarget({
      nodeId: familyId, type: REL.publishedFrom, limit: 500,
    });
    const packVersion = existingPacks.items.length + 1;

    const snapshots: DnaPackMemberSnapshot[] = [];
    for (const member of members) {
      const material = await this.#requireEntity(member.materialId, null);
      const hash = String(material.attributes.contentHash);
      const bytes = await this.#content.get(hash);
      if (!bytes) throw new IntegrityError(`material ${material.id} references missing content ${hash}`);
      const audio = decodeWav(bytes);
      const stem = String(material.attributes.filename ?? material.id).replace(/\.[^.]+$/, '');
      snapshots.push({
        order: member.order, materialId: material.id,
        filename: `${String(member.order + 1).padStart(3, '0')}-${stem}.wav`,
        contentHash: hash,
        durationSeconds: audio.channels > 0 ? audio.samples.length / audio.channels / audio.sampleRate : 0,
        sampleRate: audio.sampleRate, channels: audio.channels,
        origin: String(material.attributes.origin ?? 'unknown'),
        configurationId: (material.attributes.configurationId as string) ?? null,
        configurationVersion: (material.attributes.configurationVersion as string) ?? null,
        seed: (material.attributes.seed as number) ?? null,
      });
    }
    snapshots.sort((a, b) => a.order - b.order);

    const now = this.#clock();
    const pack: Entity = {
      id: newUuid(), type: TYPE_DNA_PACK, role: ROLE_PUBLICATION,
      lifecycleState: 'published', schemaVersion: SCHEMA_VERSION, createdAt: now,
      attributes: {
        familyId, packVersion, familyName: String(family.attributes.name),
        familyRevision: Number(family.attributes.revision ?? 1),
        memberCount: snapshots.length,
      },
    };
    const manifest: DnaPackManifest = {
      schemaVersion: SCHEMA_VERSION, packId: pack.id, packVersion,
      familyId, familyRevision: Number(family.attributes.revision ?? 1),
      familyName: String(family.attributes.name), publishedAt: now,
      publishingAgentId: agent.id, members: snapshots,
    };

    const publishTransition: Transition = {
      id: newUuid(), subject: pack.id, kind: TRANSITION_KIND.publish,
      fromState: null, toState: 'published', agentId: agent.id,
      idempotencyKey: idempotencyKey('publish', familyId, String(packVersion)),
      rationale: null, context: { familyId, packVersion },
      schemaVersion: SCHEMA_VERSION, createdAt: now,
    };
    const mutations: Mutation[] = [
      { op: 'put', collection: COLLECTIONS.entities, record: pack as never },
      { op: 'put', collection: COLLECTIONS.transitions, record: publishTransition as never },
      { op: 'put', collection: COLLECTIONS.relationships,
        record: this.#relationship(REL.publishedFrom, pack.id, familyId, agent.id, now,
          { packVersion }) as never },
    ];
    for (const snapshot of snapshots) {
      mutations.push({ op: 'put', collection: COLLECTIONS.relationships,
        record: this.#relationship(REL.packagedMaterial, pack.id, snapshot.materialId, agent.id, now,
          { order: snapshot.order, filename: snapshot.filename }) as never });
    }
    await this.#records.commit(mutations);
    return { pack, manifest };
  }

  async listPacks(familyId: string): Promise<Entity[]> {
    const page = await this.#records.adjacencyByTarget({
      nodeId: familyId, type: REL.publishedFrom, limit: 500,
    });
    const ids = (page.items as unknown as Relationship[]).map((r) => r.source);
    const rows = await this.#records.getMany(COLLECTIONS.entities, ids);
    return (rows.filter((r) => r !== null) as unknown as Entity[])
      .sort((a, b) => Number(a.attributes.packVersion) - Number(b.attributes.packVersion));
  }

  async audioFor(materialId: string): Promise<Uint8Array | null> {
    const material = await this.#requireEntity(materialId, null);
    return this.#content.get(String(material.attributes.contentHash));
  }

  // ---- helpers ---------------------------------------------------------------

  #membership(materialId: string, familyId: string, order: number, agentId: string,
              createdAt: number, existingId?: string): Relationship {
    return {
      id: existingId ?? newUuid(), type: REL.groupedIn, source: materialId, target: familyId,
      agentId, evidence: [], metadata: { order }, schemaVersion: SCHEMA_VERSION, createdAt,
    };
  }

  #relationship(type: string, source: string, target: string, agentId: string,
                createdAt: number, metadata: Record<string, Json> = {}): Relationship {
    return {
      id: newUuid(), type, source, target, agentId, evidence: [],
      metadata, schemaVersion: SCHEMA_VERSION, createdAt,
    };
  }

  #bumpRevision(family: Entity, now: number): Entity {
    return {
      ...family, updatedAt: now,
      attributes: { ...family.attributes, revision: Number(family.attributes.revision ?? 1) + 1 },
    };
  }

  async #requireAgent(agentId: string): Promise<Agent> {
    const a = await this.#records.get(COLLECTIONS.agents, agentId);
    if (!a) throw new NotFoundError(COLLECTIONS.agents, agentId);
    return a as unknown as Agent;
  }

  async #requireEntity(id: string, expectedType: string | null): Promise<Entity> {
    const e = await this.#records.get(COLLECTIONS.entities, id);
    if (!e) throw new NotFoundError(COLLECTIONS.entities, id);
    const entity = e as unknown as Entity;
    if (expectedType && entity.type !== expectedType) {
      throw new DomainRuleError(`${id} is a ${entity.type}, expected ${expectedType}`);
    }
    return entity;
  }

  /** Default eligibility: promoted Materials only — never Previews, never rejected. */
  async #requireEligibleMaterials(materialIds: readonly string[]): Promise<Entity[]> {
    if (materialIds.length === 0) {
      throw new DomainRuleError('a family requires at least one material');
    }
    const rows = await this.#records.getMany(COLLECTIONS.entities, materialIds);
    const materials: Entity[] = [];
    for (let i = 0; i < materialIds.length; i++) {
      const row = rows[i];
      if (!row) throw new NotFoundError(COLLECTIONS.entities, materialIds[i]!);
      const material = row as unknown as Entity;
      if (material.role !== ROLE_MATERIAL) {
        throw new DomainRuleError(`${material.id} is not a material`);
      }
      if (material.lifecycleState !== LIFECYCLE.promoted) {
        throw new DomainRuleError(
          `material ${material.id} is ${material.lifecycleState}, only promoted materials may enter a family`);
      }
      materials.push(material);
    }
    return materials;
  }
}
