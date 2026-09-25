import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { SqliteRecordStore } from '../../src/adapters/node-sqlite/record-store.ts';
import { COLLECTIONS } from '../../src/core/primitives.ts';
import {
  CURRENT_SCHEMA,
  collectPersistenceDiagnostics,
  migrate,
} from '../../src/migrations/index.ts';
import { SCHEMA_V1 } from '../../src/persistence/schema.ts';
import type { StoredRecord } from '../../src/persistence/record-store.ts';

interface MigrationReplayFixture {
  schema_version: number;
  name: string;
  provenance: Record<string, unknown>;
  input: {
    schemaVersion: number;
    legacyRecords: StoredRecord[];
  };
  expected: {
    schemaVersion: number;
    records: StoredRecord[];
    endorsedIds: string[];
    validatedIds: string[];
    diagnostics: Awaited<ReturnType<typeof collectPersistenceDiagnostics>>;
  };
}

const FIXTURE_PATH = resolve(
  'fixtures/replay/migrations/adr011-v1-v2-orthogonal-standings.json',
);

function loadFixture(): MigrationReplayFixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as MigrationReplayFixture;
}

async function replayMigration(
  fixture: MigrationReplayFixture,
): Promise<MigrationReplayFixture['expected']> {
  if (fixture.schema_version !== 1) {
    throw new Error(`unsupported replay fixture schema ${fixture.schema_version}`);
  }
  if (fixture.input.schemaVersion !== SCHEMA_V1.version) {
    throw new Error(
      `fixture expects source schema ${fixture.input.schemaVersion}; replay supports V1 source`,
    );
  }

  const dir = mkdtempSync(join(tmpdir(), 'pattern002-migration-replay-'));
  const dbPath = join(dir, 'store.sqlite');

  try {
    const source = new SqliteRecordStore(dbPath, SCHEMA_V1);
    await source.commit(
      fixture.input.legacyRecords.map((record) => ({
        op: 'put' as const,
        collection: COLLECTIONS.knowledge,
        record,
      })),
    );
    await source.setSchemaVersion(fixture.input.schemaVersion);
    await source.close();

    const migrated = new SqliteRecordStore(dbPath, CURRENT_SCHEMA);
    try {
      const schemaVersion = await migrate(migrated);
      const page = await migrated.scan(COLLECTIONS.knowledge, null, 100);

      const subject = String(fixture.input.legacyRecords[0]?.subject ?? '');
      const endorsed = await migrated.lookup({
        collection: COLLECTIONS.knowledge,
        index: 'kno_by_subject_institutional',
        prefix: [subject, 'endorsed'],
        limit: 100,
      });
      const validated = await migrated.lookup({
        collection: COLLECTIONS.knowledge,
        index: 'kno_by_subject_epistemic',
        prefix: [subject, 'validated'],
        limit: 100,
      });
      const diagnostics = await collectPersistenceDiagnostics(migrated);

      const firstSnapshot = {
        schemaVersion,
        records: page.items,
        endorsedIds: endorsed.items.map((record) => record.id),
        validatedIds: validated.items.map((record) => record.id),
        diagnostics,
      };

      // Replay is about deterministic projection. Re-running the production
      // migration at V2 must preserve the same observable state.
      assert.equal(await migrate(migrated), CURRENT_SCHEMA.version);
      const secondPage = await migrated.scan(COLLECTIONS.knowledge, null, 100);
      assert.deepEqual(
        secondPage.items,
        firstSnapshot.records,
        'second migration pass must not change the replayed V2 records',
      );

      return firstSnapshot;
    } finally {
      await migrated.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('PATTERN-002 replays the reviewed ADR-011 V1 -> V2 golden migration offline', async () => {
  const fixture = loadFixture();
  const actual = await replayMigration(fixture);

  assert.deepEqual(actual, fixture.expected);
});

test('PATTERN-002 rejects intentional migration expectation drift', async () => {
  const fixture = loadFixture();
  const drifted = structuredClone(fixture);

  const canon = drifted.expected.records.find((record) => record.id === 'replay-canon');
  assert.ok(canon);
  canon.institutionalStanding = 'unendorsed';

  const actual = await replayMigration(drifted);
  assert.notDeepEqual(
    actual,
    drifted.expected,
    'a corrupted golden expectation must not match the production migration',
  );

  assert.throws(
    () => assert.deepEqual(actual, drifted.expected),
    /Expected values to be strictly deep-equal/,
  );
});

test('PATTERN-002 requires an explicit fixture expectation update for an intentional contract change', async () => {
  const fixture = loadFixture();
  const changed = structuredClone(fixture);

  const source = changed.input.legacyRecords.find((record) => record.id === 'replay-validated');
  assert.ok(source);
  source.stage = 'hypothesis';

  const actual = await replayMigration(changed);

  // The old golden contract is stale and must fail first.
  assert.notDeepEqual(actual, changed.expected);

  // Review/update the expected contract explicitly.
  const expectedRecord = changed.expected.records.find(
    (record) => record.id === 'replay-validated',
  );
  assert.ok(expectedRecord);
  expectedRecord.stage = 'hypothesis';
  expectedRecord.epistemicStanding = 'hypothesis';
  changed.expected.validatedIds = [];

  assert.deepEqual(
    actual,
    changed.expected,
    'explicitly updating the reviewed fixture restores deterministic replay',
  );
});
