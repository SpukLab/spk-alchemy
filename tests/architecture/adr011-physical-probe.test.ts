import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareAdr011PhysicalMigrationProbe,
  verifyAdr011PhysicalMigrationProbe,
  cleanupAdr011PhysicalMigrationProbe,
} from '../../src/web/adr011-physical-probe.ts';

test('ADR-011 physical probe creates V1, migrates V2 and remains readable after reopen', async () => {
  const databaseName = `adr011-physical-probe-${Date.now()}-${Math.trunc(performance.now())}`;

  try {
    const phase1 = await prepareAdr011PhysicalMigrationProbe(databaseName);
    assert.equal(phase1.ok, true);
    assert.equal(phase1.schemaVersion, 2);
    assert.equal(phase1.recordIdsPreserved, true);
    assert.equal(phase1.legacyCanonBecameEndorsedUnknown, true);
    assert.equal(phase1.validatedRemainedUnendorsed, true);
    assert.equal(phase1.explicitOrthogonalStatePreserved, true);
    assert.equal(phase1.endorsementIndexConsistent, true);
    assert.equal(phase1.migrationReady, true);

    // A real browser test reloads the whole document between these two calls.
    // In CI this second independent open validates the persistence/reopen logic.
    const phase2 = await verifyAdr011PhysicalMigrationProbe(databaseName);
    assert.equal(phase2.ok, true);
    assert.equal(phase2.schemaVersion, 2);
    assert.equal(phase2.recordIdsPreserved, true);
    assert.deepEqual(phase2.diagnostics, phase1.diagnostics,
      'reopening the migrated corpus must not alter its observable state');
  } finally {
    await cleanupAdr011PhysicalMigrationProbe(databaseName);
  }
});


test('ADR-011 Safari probe starts from a fresh unique database without pre-delete', async () => {
  let deleteCalls = 0;
  const factory = {
    open: indexedDB.open.bind(indexedDB),
    deleteDatabase(name: string) {
      deleteCalls += 1;
      return indexedDB.deleteDatabase(name);
    },
  };

  const phase1 = await prepareAdr011PhysicalMigrationProbe(undefined, factory);
  assert.equal(phase1.ok, true);
  assert.match(phase1.databaseName, /^alchemy-adr011-physical-migration-probe-/);
  assert.equal(deleteCalls, 0,
    'starting a physical probe must not depend on deleting a previous Safari database');

  const phase2 = await verifyAdr011PhysicalMigrationProbe(phase1.databaseName, factory);
  assert.equal(phase2.ok, true);
  assert.equal(phase2.databaseName, phase1.databaseName);

  const cleaned = await cleanupAdr011PhysicalMigrationProbe(phase1.databaseName, factory);
  assert.equal(cleaned, true);
  assert.equal(deleteCalls, 1, 'deletion is cleanup only, never a precondition for the probe');
});
