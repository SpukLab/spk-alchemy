import type { DataRegistry } from '../../registries/data-registry.ts';
import type { ViewRegistry } from '../../registries/view-registry.ts';

export const OBS_ROLE_RESEARCH = 'observatory-research';
export const OBS_TYPE_RESEARCH_INTENT = 'observatory-research-intent';
export const OBS_TYPE_EXPERIMENT = 'observatory-experiment';

export const OBS_LIFECYCLE = {
  ready: 'ready',
  active: 'active',
  closed: 'closed',
  superseded: 'superseded',
} as const;

export const OBS_REL = {
  investigatesIntent: 'observatory_investigates_intent',
  followsFrom: 'observatory_follows_from',
  targets: 'observatory_targets',
} as const;

export const OBS_KNOWLEDGE_KIND = {
  experimentSynthesis: 'observatory-experiment-synthesis',
  researchState: 'observatory-research-state',
} as const;

export function registerObservatoryVocabulary(data: DataRegistry, view?: ViewRegistry): void {
  data.registerEntityType({
    type: OBS_TYPE_RESEARCH_INTENT,
    role: OBS_ROLE_RESEARCH,
    lifecycleStates: ['active', 'closed'],
    initialState: 'active',
    allowedTransitions: { active: ['closed'], closed: ['active'] },
  });
  data.registerEntityType({
    type: OBS_TYPE_EXPERIMENT,
    role: OBS_ROLE_RESEARCH,
    lifecycleStates: Object.values(OBS_LIFECYCLE),
    initialState: OBS_LIFECYCLE.ready,
    allowedTransitions: {
      [OBS_LIFECYCLE.ready]: [OBS_LIFECYCLE.active, OBS_LIFECYCLE.closed],
      [OBS_LIFECYCLE.active]: [OBS_LIFECYCLE.closed, OBS_LIFECYCLE.superseded],
      [OBS_LIFECYCLE.closed]: [OBS_LIFECYCLE.superseded],
      [OBS_LIFECYCLE.superseded]: [],
    },
  });

  data.registerRelationshipType({
    type: OBS_REL.investigatesIntent,
    sourceTypes: [OBS_TYPE_EXPERIMENT],
    targetTypes: [OBS_TYPE_RESEARCH_INTENT],
  });
  data.registerRelationshipType({ type: OBS_REL.followsFrom, sourceTypes: [OBS_TYPE_EXPERIMENT], targetTypes: [OBS_TYPE_EXPERIMENT] });
  data.registerRelationshipType({ type: OBS_REL.targets, sourceTypes: '*', targetTypes: '*' });

  data.registerKnowledgeKind({
    kind: OBS_KNOWLEDGE_KIND.experimentSynthesis,
    allowedStages: ['hypothesis', 'validated', 'deprecated'],
  });
  data.registerKnowledgeKind({
    kind: OBS_KNOWLEDGE_KIND.researchState,
    allowedStages: ['observation', 'validated', 'deprecated'],
  });

  view?.register(OBS_TYPE_RESEARCH_INTENT, { label: 'Research Intent', group: 'Observatory' });
  view?.register(OBS_TYPE_EXPERIMENT, { label: 'Experiment', group: 'Observatory' });
}
