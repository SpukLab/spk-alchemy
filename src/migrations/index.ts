import { SCHEMA_V1, SCHEMA_V2 } from '../persistence/schema.ts';
import type { SchemaDeclaration } from '../persistence/schema.ts';
import type { RecordStore, StoredRecord, Mutation } from '../persistence/record-store.ts';
import { COLLECTIONS } from '../core/primitives.ts';
import type {
  EpistemicStanding,
  InstitutionalStanding,
  Knowledge,
} from '../core/primitives.ts';
import {
  isLegacyEpistemicStage,
  standingsFromLegacy,
} from '../core/epistemic-state.ts';

/**
 * Migration-capable portable store.
 *
 * Both SQLite and IndexedDB already expose setSchemaVersion; keeping it in a
 * narrow migration contract avoids leaking migration machinery into ordinary
 * domain code.
 */
export interface MigrationStore extends RecordStore {
  setSchemaVersion(version: number): void | Promise<void>;
}

/**
 * Forward-only, versioned, deterministic from an empty store.
 * Index declarations are portable and live here; representation is adapter work.
 */
export interface Migration {
  version: number;
  description: string;
  schema: SchemaDeclaration;
  apply: (store: MigrationStore) => Promise<void>;
}

function validEpistemicStanding(value: unknown): value is EpistemicStanding {
  return ['unknown', 'observation', 'hypothesis', 'validated', 'durable', 'deprecated']
    .includes(String(value));
}

function validInstitutionalStanding(value: unknown): value is InstitutionalStanding {
  return ['unendorsed', 'endorsed', 'withdrawn'].includes(String(value));
}

function backfillLegacyKnowledge(record: StoredRecord): StoredRecord {
  if (!isLegacyEpistemicStage(record.stage)) {
    throw new Error(
      `cannot migrate knowledge ${record.id}: unknown legacy stage ${String(record.stage)}`,
    );
  }

  const inferred = standingsFromLegacy(record.stage);
  return {
    ...record,
    epistemicStanding: validEpistemicStanding(record.epistemicStanding)
      ? record.epistemicStanding
      : inferred.epistemic,
    institutionalStanding: validInstitutionalStanding(record.institutionalStanding)
      ? record.institutionalStanding
      : inferred.institutional,
  };
}

async function migrateKnowledgeToOrthogonalStandings(store: MigrationStore): Promise<void> {
  let after: string | null = null;
  for (;;) {
    const page = await store.scan(COLLECTIONS.knowledge, after, 200);
    if (page.items.length === 0) break;

    // Re-put EVERY Knowledge record under SCHEMA_V2. This is required even
    // when fields already exist so both adapters rebuild the new index entries.
    const batch: Mutation[] = page.items.map((raw) => ({
      op: 'put' as const,
      collection: COLLECTIONS.knowledge,
      record: backfillLegacyKnowledge(raw),
    }));
    await store.commit(batch);

    if (page.nextAfter === null) break;
    after = String(page.nextAfter[0]);
  }
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: 'canonical collections and initial index declarations',
    schema: SCHEMA_V1,
    apply: async () => { /* declarative: collections and indexes are schema-driven */ },
  },
  {
    version: 2,
    description: 'orthogonal epistemic and institutional Knowledge standings',
    schema: SCHEMA_V2,
    apply: migrateKnowledgeToOrthogonalStandings,
  },
];

export const CURRENT_SCHEMA = SCHEMA_V2;

export async function migrate(store: MigrationStore): Promise<number> {
  const current = await store.schemaVersion();
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    await m.apply(store);
    await store.setSchemaVersion(m.version);
  }
  return store.schemaVersion();
}

/**
 * Exported only for migration tests and diagnostics. Domain code should not
 * call this directly; migrate() owns the lifecycle.
 */
export function normalizeLegacyKnowledgeRecord(record: StoredRecord): Knowledge {
  return backfillLegacyKnowledge(record) as unknown as Knowledge;
}


export interface PersistenceDiagnostics {
  schemaVersion: number;
  currentSchemaVersion: number;
  knowledgeCount: number;
  missingOrthogonalStandings: number;
  endorsedCount: number;
  endorsedIndexCount: number;
  legacyCanonCount: number;
  epistemicUnknownCount: number;
  orthogonalIndexConsistent: boolean;
  migrationReady: boolean;
}

/**
 * Read-only diagnostics for physical-device migration validation.
 * This is deliberately exposed through the existing device diagnostics UI so
 * Safari/iPhone validation does not require Web Inspector or a desktop.
 */
export async function collectPersistenceDiagnostics(
  store: RecordStore,
): Promise<PersistenceDiagnostics> {
  let after: string | null = null;
  let knowledgeCount = 0;
  let missingOrthogonalStandings = 0;
  let endorsedCount = 0;
  let legacyCanonCount = 0;
  let epistemicUnknownCount = 0;

  for (;;) {
    const page = await store.scan(COLLECTIONS.knowledge, after, 200);
    for (const raw of page.items) {
      knowledgeCount += 1;
      if (!validEpistemicStanding(raw.epistemicStanding)
        || !validInstitutionalStanding(raw.institutionalStanding)) {
        missingOrthogonalStandings += 1;
      }
      if (raw.institutionalStanding === 'endorsed') endorsedCount += 1;
      if (raw.stage === 'canon') legacyCanonCount += 1;
      if (raw.epistemicStanding === 'unknown') epistemicUnknownCount += 1;
    }
    if (page.nextAfter === null) break;
    after = String(page.nextAfter[0]);
  }

  let endorsedAfter: import('../persistence/keys.ts').KeyTuple | undefined;
  let endorsedIndexCount = 0;
  for (;;) {
    const page = await store.lookup({
      collection: COLLECTIONS.knowledge,
      index: 'kno_by_subject_institutional',
      range: {},
      after: endorsedAfter,
      limit: 200,
    });
    for (const raw of page.items) {
      if (raw.institutionalStanding === 'endorsed') endorsedIndexCount += 1;
    }
    if (page.nextAfter === null) break;
    endorsedAfter = page.nextAfter;
  }

  const schemaVersion = await store.schemaVersion();
  const orthogonalIndexConsistent = endorsedIndexCount === endorsedCount;
  return {
    schemaVersion,
    currentSchemaVersion: CURRENT_SCHEMA.version,
    knowledgeCount,
    missingOrthogonalStandings,
    endorsedCount,
    endorsedIndexCount,
    legacyCanonCount,
    epistemicUnknownCount,
    orthogonalIndexConsistent,
    migrationReady:
      schemaVersion === CURRENT_SCHEMA.version
      && missingOrthogonalStandings === 0
      && orthogonalIndexConsistent,
  };
}
