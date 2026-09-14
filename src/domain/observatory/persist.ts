import { COLLECTIONS } from '../../core/primitives.ts';
import type { Mutation, RecordStore, StoredRecord } from '../../persistence/record-store.ts';
import { observatoryCheckpointV1 } from './checkpoint-v1.ts';

export async function persistObservatoryCheckpointV1(store: RecordStore): Promise<void> {
  const records: readonly [string, StoredRecord][] = [
    [COLLECTIONS.agents, observatoryCheckpointV1.agent as unknown as StoredRecord],
    [COLLECTIONS.entities, observatoryCheckpointV1.intent as unknown as StoredRecord],
    ...observatoryCheckpointV1.experiments.map((record) => [COLLECTIONS.entities, record as unknown as StoredRecord] as const),
    ...observatoryCheckpointV1.relationships.map((record) => [COLLECTIONS.relationships, record as unknown as StoredRecord] as const),
    ...observatoryCheckpointV1.knowledge.map((record) => [COLLECTIONS.knowledge, record as unknown as StoredRecord] as const),
  ];

  const mutations: Mutation[] = records.map(([collection, record]) => ({
    op: 'put',
    collection,
    record,
  }));
  await store.commit(mutations);
}
