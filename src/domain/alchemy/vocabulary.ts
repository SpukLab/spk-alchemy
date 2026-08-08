import type { DataRegistry } from '../../registries/data-registry.ts';
import type { ViewRegistry } from '../../registries/view-registry.ts';

/**
 * Alchemy domain VOCABULARY. It registers types, roles, kinds and relationship
 * contracts on the canonical registries. It introduces no structural primitive.
 */
export const ROLE_MATERIAL = 'material';
export const ROLE_RESEARCH = 'research';
export const ROLE_GROUPING = 'grouping';
export const ROLE_PUBLICATION = 'publication';

export const TYPE_AUDIO_MATERIAL = 'audio-material';
export const TYPE_RESEARCH_INTENT = 'research-intent';
export const TYPE_EXPERIMENT = 'experiment';
export const TYPE_FAMILY = 'family-grouping';
export const TYPE_DNA_PACK = 'dna-pack';

/** Material lifecycle. Preview and Discard are runtime-only and appear nowhere. */
export const LIFECYCLE = {
  retained: 'retained',
  promoted: 'promoted',
  rejected: 'rejected',
} as const;
export type LifecycleState = (typeof LIFECYCLE)[keyof typeof LIFECYCLE];

export const REL = {
  derivedFrom: 'derived_from',
  producedByExperiment: 'produced_by_experiment',
  outputOf: 'output_of',
  inputTo: 'input_to',
  investigatesIntent: 'investigates_intent',
  supersedes: 'supersedes',
  /** Material -> Family. Canonical Grouping membership. Reified so each
   *  membership carries its own order and can be added/removed/reordered
   *  without ever touching the Family Entity's own identity. */
  groupedIn: 'grouped_in',
  /** DNA Pack -> Family. Provenance: which Canonical Grouping this
   *  Published Artifact snapshot was produced from. */
  publishedFrom: 'published_from',
  /** DNA Pack -> Material. One per exported member, mirroring the frozen
   *  manifest snapshot so pack contents stay queryable like any other
   *  genealogy, not just readable from the exported file. */
  packagedMaterial: 'packaged_material',
} as const;

export const KNOWLEDGE_KIND = {
  physicalAnalysis: 'physical-analysis',
  curatedConclusion: 'curated-conclusion',
} as const;

export const TRANSITION_KIND = {
  import: 'import',
  retain: 'retain',
  promote: 'promote',
  reject: 'reject',
  familyCreate: 'family-create',
  familyEdit: 'family-edit',
  publish: 'publish',
} as const;

export function registerAlchemyVocabulary(data: DataRegistry, view?: ViewRegistry): void {
  data.registerEntityType({
    type: TYPE_AUDIO_MATERIAL,
    role: ROLE_MATERIAL,
    lifecycleStates: Object.values(LIFECYCLE),
    initialState: LIFECYCLE.retained,
    allowedTransitions: {
      [LIFECYCLE.retained]: [LIFECYCLE.promoted, LIFECYCLE.rejected],
      [LIFECYCLE.promoted]: [LIFECYCLE.rejected],
      [LIFECYCLE.rejected]: [LIFECYCLE.promoted],
    },
    validate: (attributes) => {
      if (typeof attributes.contentHash !== 'string' || attributes.contentHash.length === 0) {
        throw new Error('audio-material requires a contentHash attribute');
      }
    },
  });
  data.registerEntityType({
    type: TYPE_RESEARCH_INTENT, role: ROLE_RESEARCH,
    lifecycleStates: ['active', 'closed'], initialState: 'active',
    allowedTransitions: { active: ['closed'], closed: ['active'] },
  });
  data.registerEntityType({
    type: TYPE_EXPERIMENT, role: ROLE_RESEARCH,
    lifecycleStates: ['recorded'], initialState: 'recorded',
    allowedTransitions: { recorded: [] },
  });
  // Family: Alchemy vocabulary for Canonical Grouping. Single-state — no
  // promote/reject cycle; membership edits never change lifecycleState, only
  // attributes.revision (see family-service.ts) and updatedAt.
  data.registerEntityType({
    type: TYPE_FAMILY, role: ROLE_GROUPING,
    lifecycleStates: ['active'], initialState: 'active',
    allowedTransitions: { active: [] },
    validate: (attributes) => {
      if (typeof attributes.name !== 'string' || attributes.name.trim().length === 0) {
        throw new Error('family requires a non-empty name');
      }
    },
  });
  // DNA Pack: Alchemy vocabulary for Published Artifact. Publication is
  // immutable — one state, no transitions out of it, ever.
  data.registerEntityType({
    type: TYPE_DNA_PACK, role: ROLE_PUBLICATION,
    lifecycleStates: ['published'], initialState: 'published',
    allowedTransitions: { published: [] },
  });

  data.registerRelationshipType({ type: REL.derivedFrom,
    sourceTypes: [TYPE_AUDIO_MATERIAL], targetTypes: [TYPE_AUDIO_MATERIAL] });
  data.registerRelationshipType({ type: REL.producedByExperiment,
    sourceTypes: [TYPE_AUDIO_MATERIAL], targetTypes: [TYPE_EXPERIMENT] });
  data.registerRelationshipType({ type: REL.outputOf,
    sourceTypes: [TYPE_AUDIO_MATERIAL], targetTypes: [TYPE_EXPERIMENT] });
  data.registerRelationshipType({ type: REL.inputTo,
    sourceTypes: [TYPE_AUDIO_MATERIAL], targetTypes: [TYPE_EXPERIMENT] });
  data.registerRelationshipType({ type: REL.investigatesIntent,
    sourceTypes: [TYPE_EXPERIMENT], targetTypes: [TYPE_RESEARCH_INTENT] });
  data.registerRelationshipType({ type: REL.supersedes, sourceTypes: '*', targetTypes: '*' });
  data.registerRelationshipType({ type: REL.groupedIn,
    sourceTypes: [TYPE_AUDIO_MATERIAL], targetTypes: [TYPE_FAMILY] });
  data.registerRelationshipType({ type: REL.publishedFrom,
    sourceTypes: [TYPE_DNA_PACK], targetTypes: [TYPE_FAMILY] });
  data.registerRelationshipType({ type: REL.packagedMaterial,
    sourceTypes: [TYPE_DNA_PACK], targetTypes: [TYPE_AUDIO_MATERIAL] });

  data.registerKnowledgeKind({ kind: KNOWLEDGE_KIND.physicalAnalysis,
    allowedStages: ['observation', 'deprecated'] });
  data.registerKnowledgeKind({ kind: KNOWLEDGE_KIND.curatedConclusion,
    allowedStages: ['hypothesis', 'validated', 'canon', 'deprecated'] });

  // Presentation is optional by contract; absence must never invalidate data.
  view?.register(TYPE_AUDIO_MATERIAL, { label: 'Material', group: 'Inventory' });
  view?.register(TYPE_RESEARCH_INTENT, { label: 'Research Intent', group: 'Research' });
  view?.register(TYPE_EXPERIMENT, { label: 'Experiment', group: 'Research' });
  view?.register(TYPE_FAMILY, { label: 'Family', group: 'Curation' });
  view?.register(TYPE_DNA_PACK, { label: 'DNA Pack', group: 'Curation' });
}
