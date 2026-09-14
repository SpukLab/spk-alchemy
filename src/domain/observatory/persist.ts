import { COLLECTIONS } from '../../core/primitives.ts';
import type { Mutation, RecordStore, StoredRecord } from '../../persistence/record-store.ts';
import { observatoryCheckpointV1 } from './checkpoint-v1.ts';
import { exp016Checkpoint } from './exp-016.ts';

export async function persistObservatoryCheckpointV1(store: RecordStore): Promise<void> {
  const records: readonly [string, StoredRecord][] = [
    [COLLECTIONS.agents, observatoryCheckpointV1.agent as unknown as StoredRecord],
    [COLLECTIONS.entities, observatoryCheckpointV1.intent as unknown as StoredRecord],
    ...observatoryCheckpointV1.experiments.map((record) => [COLLECTIONS.entities, record as unknown as StoredRecord] as const),
    ...observatoryCheckpointV1.relationships.map((record) => [COLLECTIONS.relationships, record as unknown as StoredRecord] as const),
    ...observatoryCheckpointV1.knowledge.map((record) => [COLLECTIONS.knowledge, record as unknown as StoredRecord] as const),
    [COLLECTIONS.entities, exp016Checkpoint.experiment as unknown as StoredRecord],
    [COLLECTIONS.relationships, exp016Checkpoint.relationship as unknown as StoredRecord],
    [COLLECTIONS.knowledge, exp016Checkpoint.knowledge as unknown as StoredRecord],
  ];

  const mutations: Mutation[] = records.map(([collection, record]) => ({
    op: 'put',
    collection,
    record,
  }));
  await store.commit(mutations);
}
