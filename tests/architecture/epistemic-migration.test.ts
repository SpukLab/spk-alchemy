import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteRecordStore } from '../../src/adapters/node-sqlite/record-store.ts';
import { IndexedDbRecordStore } from '../../src/adapters/indexeddb/record-store.ts';
import type { MigrationStore } from '../../src/migrations/index.ts';
import { migrate, CURRENT_SCHEMA } from '../../src/migrations/index.ts';
import { SCHEMA_V1 } from '../../src/persistence/schema.ts';
import { COLLECTIONS } from '../../src/core/primitives.ts';
import type { Knowledge } from '../../src/core/primitives.ts';

const legacy = (id: string, stage: string, createdAt: number, extra: Record<string, unknown> = {}) => ({
  id,
  subject: 'subject-1',
  subjectKind: 'entity',
  kind: 'curated-conclusion',
  stage,
  payload: { note: id },
  agentId: 'agent-1',
  agentVersion: '1',
  evidence: [],
  confidence: null,
  schemaVersion: 1,
  createdAt,
  supersedes: null,
  ...extra,
});

async function seedLegacy(store: MigrationStore): Promise<void> {
  await store.commit([
    { op: 'put', collection: COLLECTIONS.knowledge, record: legacy('k-canon', 'canon', 1) },
    { op: 'put', collection: COLLECTIONS.knowledge, record: legacy('k-validated', 'validated', 2) },
    { op: 'put', collection: COLLECTIONS.knowledge, record: legacy('k-observation', 'observation', 3) },
    {
      op: 'put',
      collection: COLLECTIONS.knowledge,
      record: legacy('k-explicit', 'canon', 4, {
        epistemicStanding: 'hypothesis',
        institutionalStanding: 'endorsed',
      }),
    },
  ]);
  await store.setSchemaVersion(1);
}

async function assertMigrated(store: MigrationStore): Promise<void> {
  assert.equal(await migrate(store), 2);

  const canon = await store.get(COLLECTIONS.knowledge, 'k-canon') as unknown as Knowledge;
  assert.equal(canon.epistemicStanding, 'unknown',
    'legacy canon must not be backfilled as validated/durable');
  assert.equal(canon.institutionalStanding, 'endorsed');

  const validated = await store.get(
    COLLECTIONS.knowledge, 'k-validated') as unknown as Knowledge;
  assert.equal(validated.epistemicStanding, 'validated');
  assert.equal(validated.institutionalStanding, 'unendorsed');

  const observation = await store.get(
    COLLECTIONS.knowledge, 'k-observation') as unknown as Knowledge;
  assert.equal(observation.epistemicStanding, 'observation');
  assert.equal(observation.institutionalStanding, 'unendorsed');

  const explicit = await store.get(
    COLLECTIONS.knowledge, 'k-explicit') as unknown as Knowledge;
  assert.equal(explicit.epistemicStanding, 'hypothesis',
    'explicit orthogonal state must win over legacy inference');
  assert.equal(explicit.institutionalStanding, 'endorsed');

  const endorsed = await store.lookup({
    collection: COLLECTIONS.knowledge,
    index: 'kno_by_subject_institutional',
    prefix: ['subject-1', 'endorsed'],
    limit: 20,
  });
  assert.deepEqual(endorsed.items.map((x) => x.id), ['k-canon', 'k-explicit']);

  const epistemicValidated = await store.lookup({
    collection: COLLECTIONS.knowledge,
    index: 'kno_by_subject_epistemic',
    prefix: ['subject-1', 'validated'],
    limit: 20,
  });
  assert.deepEqual(epistemicValidated.items.map((x) => x.id), ['k-validated']);

  const before = await store.scan(COLLECTIONS.knowledge, null, 100);
  assert.equal(await migrate(store), 2, 'migration is idempotent after version advance');
  const after = await store.scan(COLLECTIONS.knowledge, null, 100);
  assert.deepEqual(after.items, before.items, 'second migration pass changes no records');
}

test('ADR-011 V2 migration backfills and reindexes legacy SQLite Knowledge', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spk-migrate-v2-'));
  const path = join(dir, 'store.sqlite');

  const v1 = new SqliteRecordStore(path, SCHEMA_V1);
  await seedLegacy(v1);
  await v1.close();

  const v2 = new SqliteRecordStore(path, CURRENT_SCHEMA);
  await assertMigrated(v2);
  await v2.close();
});

test('ADR-011 V2 migration backfills and reindexes legacy IndexedDB Knowledge', async () => {
  const name = `adr011-migrate-${Date.now()}-${Math.trunc(performance.now())}`;

  const v1 = await IndexedDbRecordStore.open(name, SCHEMA_V1);
  await seedLegacy(v1);
  await v1.close();

  const v2 = await IndexedDbRecordStore.open(name, CURRENT_SCHEMA);
  await assertMigrated(v2);
  await v2.close();
});

test('ADR-011 V2 migration produces equivalent observable state across adapters', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spk-migrate-equiv-'));
  const sqlitePath = join(dir, 'store.sqlite');
  const idbName = `adr011-equiv-${Date.now()}-${Math.trunc(performance.now())}`;

  const sqliteV1 = new SqliteRecordStore(sqlitePath, SCHEMA_V1);
  const idbV1 = await IndexedDbRecordStore.open(idbName, SCHEMA_V1);
  await seedLegacy(sqliteV1);
  await seedLegacy(idbV1);
  await sqliteV1.close();
  await idbV1.close();

  const sqlite = new SqliteRecordStore(sqlitePath, CURRENT_SCHEMA);
  const idb = await IndexedDbRecordStore.open(idbName, CURRENT_SCHEMA);
  await migrate(sqlite);
  await migrate(idb);

  const snapshot = async (store: MigrationStore) => {
    const rows = await store.scan(COLLECTIONS.knowledge, null, 100);
    const endorsed = await store.lookup({
      collection: COLLECTIONS.knowledge,
      index: 'kno_by_subject_institutional',
      prefix: ['subject-1', 'endorsed'],
      limit: 20,
    });
    return {
      rows: rows.items,
      endorsed: endorsed.items.map((x) => x.id),
    };
  };

  assert.deepEqual(await snapshot(sqlite), await snapshot(idb),
    'SQLite and IndexedDB expose identical migrated records and Canon view');

  await sqlite.close();
  await idb.close();
});
