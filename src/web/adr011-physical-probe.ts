import { IndexedDbRecordStore } from '../adapters/indexeddb/record-store.ts';
import { COLLECTIONS } from '../core/primitives.ts';
import type { Knowledge } from '../core/primitives.ts';
import { SCHEMA_V1 } from '../persistence/schema.ts';
import {
  CURRENT_SCHEMA,
  collectPersistenceDiagnostics,
  migrate,
} from '../migrations/index.ts';
import type { PersistenceDiagnostics } from '../migrations/index.ts';

export const ADR011_PHYSICAL_PROBE_DB = 'alchemy-adr011-physical-migration-probe';

type IDBFactoryLike = Pick<IDBFactory, 'open' | 'deleteDatabase'>;

export interface Adr011PhysicalProbeResult {
  ok: boolean;
  databaseName: string;
  schemaVersion: number;
  currentSchemaVersion: number;
  recordIdsPreserved: boolean;
  legacyCanonBecameEndorsedUnknown: boolean;
  validatedRemainedUnendorsed: boolean;
  explicitOrthogonalStatePreserved: boolean;
  endorsementIndexConsistent: boolean;
  migrationReady: boolean;
  diagnostics: PersistenceDiagnostics;
}

const SUBJECT = 'adr011-physical-probe-subject';
const IDS = ['adr011-probe-canon', 'adr011-probe-validated', 'adr011-probe-explicit'] as const;

function legacy(
  id: string,
  stage: 'canon' | 'validated',
  createdAt: number,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    subject: SUBJECT,
    subjectKind: 'entity',
    kind: 'curated-conclusion',
    stage,
    payload: { probe: 'ADR-011 physical Safari migration', id },
    agentId: 'adr011-probe-agent',
    agentVersion: '1',
    evidence: [],
    confidence: null,
    schemaVersion: 1,
    createdAt,
    supersedes: null,
    ...extra,
  };
}

function idb(factory?: IDBFactoryLike): IDBFactoryLike {
  const resolved = factory ?? globalThis.indexedDB;
  if (!resolved) throw new Error('IndexedDB is not available');
  return resolved;
}

function deleteDatabase(name: string, factory?: IDBFactoryLike): Promise<void> {
  const req = idb(factory).deleteDatabase(name);
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error('could not delete probe database'));
    req.onblocked = () => reject(new Error('probe database deletion blocked by an open connection'));
  });
}

async function seedLegacyCorpus(
  databaseName: string,
  factory?: IDBFactoryLike,
): Promise<void> {
  const store = await IndexedDbRecordStore.open(databaseName, SCHEMA_V1, idb(factory));
  try {
    await store.commit([
      {
        op: 'put',
        collection: COLLECTIONS.knowledge,
        record: legacy('adr011-probe-canon', 'canon', 1),
      },
      {
        op: 'put',
        collection: COLLECTIONS.knowledge,
        record: legacy('adr011-probe-validated', 'validated', 2),
      },
      {
        op: 'put',
        collection: COLLECTIONS.knowledge,
        record: legacy('adr011-probe-explicit', 'canon', 3, {
          epistemicStanding: 'hypothesis',
          institutionalStanding: 'endorsed',
        }),
      },
    ]);
    await store.setSchemaVersion(1);
  } finally {
    await store.close();
  }
}

async function inspectMigratedCorpus(
  databaseName: string,
  factory?: IDBFactoryLike,
): Promise<Adr011PhysicalProbeResult> {
  const store = await IndexedDbRecordStore.open(databaseName, CURRENT_SCHEMA, idb(factory));
  try {
    await migrate(store);

    const records = await Promise.all(
      IDS.map((recordId) => store.get(COLLECTIONS.knowledge, recordId)),
    ) as unknown as (Knowledge | null)[];

    const [canon, validated, explicit] = records;
    const recordIdsPreserved = records.every((record, index) => record?.id === IDS[index]);

    const endorsed = await store.lookup({
      collection: COLLECTIONS.knowledge,
      index: 'kno_by_subject_institutional',
      prefix: [SUBJECT, 'endorsed'],
      limit: 20,
    });
    const endorsedIds = endorsed.items.map((record) => record.id);

    const diagnostics = await collectPersistenceDiagnostics(store);
    const legacyCanonBecameEndorsedUnknown =
      canon?.epistemicStanding === 'unknown'
      && canon.institutionalStanding === 'endorsed';
    const validatedRemainedUnendorsed =
      validated?.epistemicStanding === 'validated'
      && validated.institutionalStanding === 'unendorsed';
    const explicitOrthogonalStatePreserved =
      explicit?.epistemicStanding === 'hypothesis'
      && explicit.institutionalStanding === 'endorsed';
    const endorsementIndexConsistent =
      diagnostics.orthogonalIndexConsistent
      && endorsedIds.includes('adr011-probe-canon')
      && endorsedIds.includes('adr011-probe-explicit')
      && !endorsedIds.includes('adr011-probe-validated');

    const ok =
      diagnostics.schemaVersion === CURRENT_SCHEMA.version
      && recordIdsPreserved
      && legacyCanonBecameEndorsedUnknown
      && validatedRemainedUnendorsed
      && explicitOrthogonalStatePreserved
      && endorsementIndexConsistent
      && diagnostics.migrationReady;

    return {
      ok,
      databaseName,
      schemaVersion: diagnostics.schemaVersion,
      currentSchemaVersion: CURRENT_SCHEMA.version,
      recordIdsPreserved,
      legacyCanonBecameEndorsedUnknown,
      validatedRemainedUnendorsed,
      explicitOrthogonalStatePreserved,
      endorsementIndexConsistent,
      migrationReady: diagnostics.migrationReady,
      diagnostics,
    };
  } finally {
    await store.close();
  }
}

/**
 * Phase 1 for the physical-device gate.
 *
 * Uses a dedicated probe database, never the user's Alchemy corpus. It creates a
 * genuine schema-v1 IndexedDB database, closes it, then reopens that SAME
 * database at schema v2 and executes the production migration path.
 *
 * The caller must reload the page after this succeeds. Verification after that
 * reload is phase 2 and proves the migrated corpus remains readable across a
 * real Safari document lifecycle.
 */
export async function prepareAdr011PhysicalMigrationProbe(
  databaseName: string = ADR011_PHYSICAL_PROBE_DB,
  factory?: IDBFactoryLike,
): Promise<Adr011PhysicalProbeResult> {
  await deleteDatabase(databaseName, factory);
  await seedLegacyCorpus(databaseName, factory);
  return inspectMigratedCorpus(databaseName, factory);
}

/**
 * Phase 2: reopen the already-migrated probe after a real page reload.
 * migrate() runs again intentionally to prove the V2 migration is idempotent.
 */
export async function verifyAdr011PhysicalMigrationProbe(
  databaseName: string = ADR011_PHYSICAL_PROBE_DB,
  factory?: IDBFactoryLike,
): Promise<Adr011PhysicalProbeResult> {
  return inspectMigratedCorpus(databaseName, factory);
}

export async function cleanupAdr011PhysicalMigrationProbe(
  databaseName: string = ADR011_PHYSICAL_PROBE_DB,
  factory?: IDBFactoryLike,
): Promise<void> {
  await deleteDatabase(databaseName, factory);
}
