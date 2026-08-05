import type { RecordStore, Mutation } from '../../persistence/record-store.ts';
import type { ContentStore } from '../../persistence/content-store.ts';
import type { DataRegistry } from '../../registries/data-registry.ts';
import type {
  Agent, AgentKind, Entity, Knowledge, Relationship, Transition, Json,
} from '../../core/primitives.ts';
import { COLLECTIONS } from '../../core/primitives.ts';
import { newUuid, contentHash, idempotencyKey } from '../../core/ids.ts';
import { DomainRuleError, IntegrityError, NotFoundError } from '../../core/errors.ts';
import {
  LIFECYCLE, REL, KNOWLEDGE_KIND, TRANSITION_KIND, ROLE_MATERIAL,
  TYPE_AUDIO_MATERIAL, TYPE_EXPERIMENT, TYPE_RESEARCH_INTENT,
} from './vocabulary.ts';
import type { LifecycleState } from './vocabulary.ts';
import type { AnalyzerDefinition } from '../../audio/analyzer.ts';
import { analyzeBytes, ANALYSIS_SCHEMA_VERSION } from '../../audio/analyzer.ts';
import type { OperationName, OperationParameters } from '../../audio/experiment.ts';
import { applyOperation, IMPLEMENTATION_VERSION } from '../../audio/experiment.ts';
import type { ResearchConfiguration } from './research-configuration.ts';
import { describeParameters } from './research-configuration.ts';
import type { PreviewSet, PreviewVariation } from './exploration.ts';
import { decodeWav } from '../../audio/wav.ts';

const SCHEMA_VERSION = 1;

/**
 * A Preview exists only in runtime. It has no canonical identity, is absent
 * from persistent genealogy, and disappearing costs no canonical knowledge.
 */
export interface Preview {
  readonly kind: 'preview';
  readonly stagingRef: string;
  readonly experimentId: string;
  readonly sourceMaterialIds: readonly string[];
  readonly operation: OperationName | string;
  readonly parameters: OperationParameters | Record<string, unknown>;
  readonly implementationVersion: string;
  readonly bytes: Uint8Array;
  readonly contentHash: string;
  /** Present when the Preview came from a ResearchConfiguration execution. */
  readonly exploration?: {
    configurationId: string;
    configurationVersion: string;
    variationIndex: number;
    seed: number;
  };
}

export interface RetainResult { material: Entity; transition: Transition; created: boolean }
export interface LifecycleResult { material: Entity; transition: Transition; changed: boolean }

export class AlchemyService {
  readonly #records: RecordStore;
  readonly #content: ContentStore;
  readonly #registry: DataRegistry;
  #clock: () => number;

  constructor(records: RecordStore, content: ContentStore, registry: DataRegistry,
              clock: () => number = () => Date.now()) {
    this.#records = records; this.#content = content;
    this.#registry = registry; this.#clock = clock;
  }

  // ---- agents --------------------------------------------------------------

  async registerAgent(input: {
    kind: AgentKind; name: string; version: string;
    metadata?: Record<string, Json>;
  }): Promise<Agent> {
    const existing = await this.#records.lookup({
      collection: COLLECTIONS.agents, index: 'agt_by_kind_name_version',
      eq: [input.kind, input.name, input.version], limit: 1,
    });
    if (existing.items.length > 0) return existing.items[0] as unknown as Agent;
    const agent: Agent = {
      id: newUuid(), kind: input.kind, name: input.name, version: input.version,
      metadata: input.metadata ?? {}, status: 'active',
      schemaVersion: SCHEMA_VERSION, createdAt: this.#clock(),
    };
    await this.#records.commit([
      { op: 'put', collection: COLLECTIONS.agents, record: agent as never },
    ]);
    return agent;
  }

  async #requireAgent(agentId: string): Promise<Agent> {
    const a = await this.#records.get(COLLECTIONS.agents, agentId);
    if (!a) throw new NotFoundError(COLLECTIONS.agents, agentId);
    return a as unknown as Agent;
  }

  // ---- import --------------------------------------------------------------

  /**
   * Import creates a persistent Material Entity per occurrence. Two imports of
   * identical bytes produce two UUIDs and one shared content hash: entity
   * identity and content identity answer different questions.
   */
  async importMaterial(input: {
    bytes: Uint8Array; filename: string; agentId: string;
  }): Promise<Entity> {
    await this.#requireAgent(input.agentId);
    const hash = contentHash(input.bytes);
    // Content first: an abandoned import leaves a collectable blob, never a
    // record pointing at absent content.
    await this.#content.put(input.bytes);
    if (!(await this.#content.has(hash))) {
      throw new IntegrityError(`content ${hash} not durable after write`);
    }
    const now = this.#clock();
    const material: Entity = {
      id: newUuid(), type: TYPE_AUDIO_MATERIAL, role: ROLE_MATERIAL,
      lifecycleState: LIFECYCLE.promoted, // imported deliberately by a human agent
      schemaVersion: SCHEMA_VERSION, createdAt: now,
      attributes: {
        contentHash: hash, filename: input.filename,
        byteLength: input.bytes.byteLength, origin: 'import',
      },
    };
    this.#registry.entityType(material.type).validate?.(material.attributes);
    const transition: Transition = {
      id: newUuid(), subject: material.id, kind: TRANSITION_KIND.import,
      fromState: null, toState: LIFECYCLE.promoted, agentId: input.agentId,
      idempotencyKey: idempotencyKey('import', material.id),
      rationale: null, context: { contentHash: hash },
      schemaVersion: SCHEMA_VERSION, createdAt: now,
    };
    await this.#records.commit([
      { op: 'put', collection: COLLECTIONS.entities, record: material as never },
      { op: 'put', collection: COLLECTIONS.transitions, record: transition as never },
    ]);
    return material;
  }

  // ---- observation ---------------------------------------------------------

  async analyzeMaterial(materialId: string, analyzer: AnalyzerDefinition,
                        analyzerAgentId: string): Promise<Knowledge> {
    const agent = await this.#requireAgent(analyzerAgentId);
    const material = await this.#requireEntity(materialId);
    const hash = String(material.attributes.contentHash);
    const bytes = await this.#content.get(hash);
    if (!bytes) throw new IntegrityError(`material ${materialId} references missing content ${hash}`);
    const metrics = analyzeBytes(analyzer, bytes);
    const observation: Knowledge = {
      id: newUuid(), subject: materialId, subjectKind: 'entity',
      kind: KNOWLEDGE_KIND.physicalAnalysis, stage: 'observation',
      payload: { ...metrics, sourceContentHash: hash, analysisSchemaVersion: ANALYSIS_SCHEMA_VERSION },
      agentId: agent.id, agentVersion: agent.version, evidence: [hash],
      confidence: null, schemaVersion: SCHEMA_VERSION,
      createdAt: this.#clock(), supersedes: null,
    };
    await this.#records.commit([
      { op: 'put', collection: COLLECTIONS.knowledge, record: observation as never },
    ]);
    return observation;
  }

  /** Curated human conclusion; used to demonstrate the canon view. */
  async assertKnowledge(input: {
    subject: string; kind: string; stage: Knowledge['stage'];
    payload: Record<string, Json>; agentId: string;
    confidence?: number; supersedes?: string; evidence?: string[];
  }): Promise<Knowledge> {
    const agent = await this.#requireAgent(input.agentId);
    const def = this.#registry.knowledgeKind(input.kind);
    if (!def.allowedStages.includes(input.stage)) {
      throw new DomainRuleError(`stage ${input.stage} not allowed for kind ${input.kind}`);
    }
    const record: Knowledge = {
      id: newUuid(), subject: input.subject, subjectKind: 'entity',
      kind: input.kind, stage: input.stage, payload: input.payload,
      agentId: agent.id, agentVersion: agent.version,
      evidence: input.evidence ?? [], confidence: input.confidence ?? null,
      schemaVersion: SCHEMA_VERSION, createdAt: this.#clock(),
      supersedes: input.supersedes ?? null,
    };
    await this.#records.commit([
      { op: 'put', collection: COLLECTIONS.knowledge, record: record as never },
    ]);
    return record;
  }

  // ---- research intent and experiments -------------------------------------

  async createResearchIntent(input: {
    question: string; successCriteria?: string; agentId: string;
  }): Promise<Entity> {
    await this.#requireAgent(input.agentId);
    const intent: Entity = {
      id: newUuid(), type: TYPE_RESEARCH_INTENT, role: 'research',
      lifecycleState: 'active', schemaVersion: SCHEMA_VERSION,
      createdAt: this.#clock(),
      attributes: {
        question: input.question,
        successCriteria: input.successCriteria ?? null,
      },
    };
    await this.#records.commit([
      { op: 'put', collection: COLLECTIONS.entities, record: intent as never },
    ]);
    return intent;
  }

  /** An Experiment without a pre-existing Research Intent is an invalid state. */
  async createExperiment(input: {
    researchIntentId: string; inputMaterialIds: readonly string[];
    operation: OperationName; parameters?: OperationParameters; agentId: string;
    configuration?: ResearchConfiguration; baseSeed?: number;
  }): Promise<Entity> {
    await this.#requireAgent(input.agentId);
    if (!input.researchIntentId) {
      throw new DomainRuleError('experiment requires at least one Research Intent');
    }
    const intent = await this.#records.get(COLLECTIONS.entities, input.researchIntentId);
    if (!intent || (intent as unknown as Entity).type !== TYPE_RESEARCH_INTENT) {
      throw new DomainRuleError(
        `experiment references a Research Intent that does not exist: ${input.researchIntentId}`);
    }
    if (input.inputMaterialIds.length === 0) {
      throw new DomainRuleError('experiment requires at least one input material');
    }
    const now = this.#clock();
    const experiment: Entity = {
      id: newUuid(), type: TYPE_EXPERIMENT, role: 'research',
      lifecycleState: 'recorded', schemaVersion: SCHEMA_VERSION, createdAt: now,
      attributes: {
        operation: input.operation,
        parameters: (input.parameters ?? {}) as Json,
        implementationVersion: input.configuration?.implementationVersion ?? IMPLEMENTATION_VERSION,
        executionAgentId: input.agentId,
        ...(input.configuration ? {
          configurationId: input.configuration.id,
          configurationVersion: input.configuration.version,
          configurationSchemaVersion: input.configuration.schemaVersion,
          operationSequence: input.configuration.operations.map((o) => o.operation),
          baseSeed: input.baseSeed ?? null,
        } : {}),
      },
    };
    const mutations: Mutation[] = [
      { op: 'put', collection: COLLECTIONS.entities, record: experiment as never },
      { op: 'put', collection: COLLECTIONS.relationships,
        record: this.#relationship(REL.investigatesIntent, experiment.id,
          input.researchIntentId, input.agentId, now) as never },
    ];
    for (const materialId of input.inputMaterialIds) {
      const m = await this.#requireEntity(materialId);
      mutations.push({ op: 'put', collection: COLLECTIONS.relationships,
        record: this.#relationship(REL.inputTo, m.id, experiment.id,
          input.agentId, now, { inputContentHash: m.attributes.contentHash as Json }) as never });
    }
    await this.#records.commit(mutations);
    return experiment;
  }

  /** Runs the experiment and returns a runtime Preview. Nothing is persisted. */
  async runExperiment(experimentId: string): Promise<Preview> {
    const experiment = await this.#requireEntity(experimentId);
    const inputs = await this.#experimentInputs(experimentId);
    if (inputs.length === 0) throw new DomainRuleError(`experiment ${experimentId} has no inputs`);
    const source = inputs[0]!;
    const hash = String(source.attributes.contentHash);
    const bytes = await this.#content.get(hash);
    if (!bytes) throw new IntegrityError(`missing content ${hash} for material ${source.id}`);
    const operation = experiment.attributes.operation as OperationName;
    const parameters = (experiment.attributes.parameters ?? {}) as OperationParameters;
    const outputBytes = applyOperation(operation, bytes, parameters);
    const outputHash = contentHash(outputBytes);
    return {
      kind: 'preview',
      stagingRef: idempotencyKey('preview', experimentId, outputHash),
      experimentId, sourceMaterialIds: inputs.map((m) => m.id),
      operation, parameters,
      implementationVersion: String(experiment.attributes.implementationVersion),
      bytes: outputBytes, contentHash: outputHash,
    };
  }

  /**
   * Execute one ResearchConfiguration over a Material and return a runtime
   * Preview Set. Nothing is persisted: each variation stays runtime state until
   * an explicit Retain, exactly as ADR-008 requires.
   */
  async runResearchConfiguration(input: {
    materialId: string;
    configuration: ResearchConfiguration;
    researchIntentId: string;
    baseSeed: number;
    variationCount?: number;
    agentId: string;
  }): Promise<PreviewSet> {
    const agent = await this.#requireAgent(input.agentId);
    const material = await this.#requireEntity(input.materialId);
    const intent = await this.#records.get(COLLECTIONS.entities, input.researchIntentId);
    if (!intent || (intent as unknown as Entity).type !== TYPE_RESEARCH_INTENT) {
      throw new DomainRuleError(
        `exploration references a Research Intent that does not exist: ${input.researchIntentId}`);
    }
    const hash = String(material.attributes.contentHash);
    const bytes = await this.#content.get(hash);
    if (!bytes) throw new IntegrityError(`missing content ${hash} for material ${material.id}`);

    const cfg = input.configuration;
    const audio = decodeWav(bytes);
    const frames = audio.samples.length / audio.channels;
    if (frames < cfg.inputConstraints.minFrames) {
      throw new DomainRuleError(
        `material ${material.id} has ${frames} frames, below the configuration minimum ` +
        `of ${cfg.inputConstraints.minFrames}`);
    }
    if (audio.channels > cfg.inputConstraints.maxChannels) {
      throw new DomainRuleError(
        `material ${material.id} has ${audio.channels} channels, above the configuration ` +
        `maximum of ${cfg.inputConstraints.maxChannels}`);
    }

    // One Experiment records the exploration as a reproducible research action.
    const experiment = await this.createExperiment({
      researchIntentId: input.researchIntentId,
      inputMaterialIds: [material.id],
      operation: 'exploration' as OperationName,
      parameters: {} as OperationParameters,
      agentId: input.agentId,
      configuration: cfg,
      baseSeed: input.baseSeed,
    });

    const count = input.variationCount ?? cfg.defaultVariationCount;
    const variations: PreviewVariation[] = [];
    for (let index = 0; index < count; index++) {
      const seed = cfg.variationSeed(input.baseSeed, index);
      const outputBytes = cfg.render(bytes, seed);
      const outputHash = contentHash(outputBytes);
      const preview: Preview = {
        kind: 'preview',
        stagingRef: idempotencyKey('preview', experiment.id, String(seed), outputHash),
        experimentId: experiment.id,
        sourceMaterialIds: [material.id],
        operation: cfg.id,
        parameters: { configurationId: cfg.id, configurationVersion: cfg.version, seed },
        implementationVersion: cfg.implementationVersion,
        bytes: outputBytes,
        contentHash: outputHash,
        exploration: {
          configurationId: cfg.id, configurationVersion: cfg.version,
          variationIndex: index, seed,
        },
      };
      variations.push({
        index, seed, preview,
        derivedParameters: describeParameters(seed, frames),
      });
    }

    return {
      kind: 'preview-set',
      researchIntentId: input.researchIntentId,
      sourceMaterialIds: [material.id],
      configurationId: cfg.id,
      configurationVersion: cfg.version,
      implementationVersion: cfg.implementationVersion,
      baseSeed: input.baseSeed,
      variations,
      executionAgentId: agent.id,
      createdAt: this.#clock(),
    };
  }

  /** Discard: allow runtime state to disappear. No canonical record is written. */
  discardPreview(_preview: Preview): void { /* intentionally empty */ }

  // ---- retain / promote / reject ------------------------------------------

  /**
   * Retain is the explicit boundary from runtime to persistent identity.
   * Order is the guarantee: content bytes first (verified), then one bounded
   * atomic batch of semantic record mutations. No domain decision occurs inside
   * the commit, and no transaction is held open while deciding what to write.
   */
  async retain(preview: Preview, agentId: string, rationale?: string): Promise<RetainResult> {
    await this.#requireAgent(agentId);
    const key = idempotencyKey('retain', preview.stagingRef);

    // Idempotent no-op: a retried Retain must not duplicate identity.
    const prior = await this.#records.lookup({
      collection: COLLECTIONS.transitions, index: 'tra_by_idempotency',
      eq: [key], limit: 1,
    });
    if (prior.items.length > 0) {
      const t = prior.items[0] as unknown as Transition;
      return { material: await this.#requireEntity(t.subject), transition: t, created: false };
    }

    // 1. Content step, idempotent by hash, verified before any record exists.
    await this.#content.put(preview.bytes);
    if (!(await this.#content.has(preview.contentHash))) {
      throw new IntegrityError(`content ${preview.contentHash} not durable after write`);
    }

    // 2. Prepare the complete batch. Everything below is already decided.
    const now = this.#clock();
    const material: Entity = {
      id: newUuid(), type: TYPE_AUDIO_MATERIAL, role: ROLE_MATERIAL,
      lifecycleState: LIFECYCLE.retained,
      schemaVersion: SCHEMA_VERSION, createdAt: now,
      attributes: {
        contentHash: preview.contentHash,
        byteLength: preview.bytes.byteLength,
        origin: preview.exploration ? 'exploration' : 'experiment',
        operation: preview.operation,
        parameters: preview.parameters as Json,
        implementationVersion: preview.implementationVersion,
        ...(preview.exploration ? {
          configurationId: preview.exploration.configurationId,
          configurationVersion: preview.exploration.configurationVersion,
          variationIndex: preview.exploration.variationIndex,
          seed: preview.exploration.seed,
        } : {}),
      },
    };
    this.#registry.entityType(material.type).validate?.(material.attributes);

    const intentId = await this.#intentOfExperiment(preview.experimentId);
    const transition: Transition = {
      id: newUuid(), subject: material.id, kind: TRANSITION_KIND.retain,
      fromState: null, toState: LIFECYCLE.retained, agentId,
      idempotencyKey: key, rationale: rationale ?? null,
      context: {
        stagingRef: preview.stagingRef, experimentId: preview.experimentId,
        researchIntentId: intentId, outputContentHash: preview.contentHash,
        implementationVersion: preview.implementationVersion,
      },
      schemaVersion: SCHEMA_VERSION, createdAt: now,
    };

    const mutations: Mutation[] = [
      { op: 'put', collection: COLLECTIONS.entities, record: material as never },
      { op: 'put', collection: COLLECTIONS.transitions, record: transition as never },
      { op: 'put', collection: COLLECTIONS.relationships,
        record: this.#relationship(REL.producedByExperiment, material.id,
          preview.experimentId, agentId, now) as never },
      { op: 'put', collection: COLLECTIONS.relationships,
        record: this.#relationship(REL.outputOf, material.id,
          preview.experimentId, agentId, now) as never },
    ];
    for (const sourceId of preview.sourceMaterialIds) {
      mutations.push({ op: 'put', collection: COLLECTIONS.relationships,
        record: this.#relationship(REL.derivedFrom, material.id, sourceId,
          agentId, now, { operation: preview.operation }) as never });
    }

    // 3. One bounded atomic commit.
    await this.#records.commit(mutations);
    return { material, transition, created: true };
  }

  async promote(materialId: string, agentId: string, rationale?: string): Promise<LifecycleResult> {
    return this.#lifecycle(materialId, LIFECYCLE.promoted, TRANSITION_KIND.promote, agentId, rationale);
  }
  async reject(materialId: string, agentId: string, rationale?: string): Promise<LifecycleResult> {
    return this.#lifecycle(materialId, LIFECYCLE.rejected, TRANSITION_KIND.reject, agentId, rationale);
  }

  async #lifecycle(materialId: string, target: LifecycleState, kind: string,
                   agentId: string, rationale?: string): Promise<LifecycleResult> {
    await this.#requireAgent(agentId);
    const material = await this.#requireEntity(materialId);
    const key = idempotencyKey(kind, materialId, target);

    // Applying a completed transition is an explicit idempotent no-op.
    if (material.lifecycleState === target) {
      const prior = await this.#records.lookup({
        collection: COLLECTIONS.transitions, index: 'tra_by_idempotency', eq: [key], limit: 1,
      });
      if (prior.items.length > 0) {
        return { material, transition: prior.items[0] as unknown as Transition, changed: false };
      }
    }
    this.#registry.assertTransitionAllowed(material.type, material.lifecycleState, target);

    const now = this.#clock();
    const updated: Entity = { ...material, lifecycleState: target, updatedAt: now };
    const transition: Transition = {
      id: newUuid(), subject: materialId, kind,
      fromState: material.lifecycleState, toState: target, agentId,
      idempotencyKey: key, rationale: rationale ?? null, context: {},
      schemaVersion: SCHEMA_VERSION, createdAt: now,
    };
    await this.#records.commit([
      { op: 'put', collection: COLLECTIONS.entities, record: updated as never },
      { op: 'put', collection: COLLECTIONS.transitions, record: transition as never },
    ]);
    return { material: updated, transition, changed: true };
  }

  // ---- helpers -------------------------------------------------------------

  #relationship(type: string, source: string, target: string, agentId: string,
                createdAt: number, metadata: Record<string, Json> = {}): Relationship {
    return {
      id: newUuid(), type, source, target, agentId, evidence: [],
      metadata, schemaVersion: SCHEMA_VERSION, createdAt,
    };
  }

  async #requireEntity(id: string): Promise<Entity> {
    const e = await this.#records.get(COLLECTIONS.entities, id);
    if (!e) throw new NotFoundError(COLLECTIONS.entities, id);
    return e as unknown as Entity;
  }

  async #experimentInputs(experimentId: string): Promise<Entity[]> {
    const page = await this.#records.adjacencyByTarget({
      nodeId: experimentId, type: REL.inputTo, limit: 100,
    });
    const ids = page.items.map((r) => (r as unknown as Relationship).source);
    const rows = await this.#records.getMany(COLLECTIONS.entities, ids);
    return rows.filter((r): r is NonNullable<typeof r> => r !== null) as unknown as Entity[];
  }

  async #intentOfExperiment(experimentId: string): Promise<string | null> {
    const page = await this.#records.adjacencyBySource({
      nodeId: experimentId, type: REL.investigatesIntent, limit: 1,
    });
    return page.items.length > 0 ? (page.items[0] as unknown as Relationship).target : null;
  }
}
