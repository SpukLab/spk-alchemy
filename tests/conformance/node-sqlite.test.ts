import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteRecordStore } from '../../src/adapters/node-sqlite/record-store.ts';
import { runConformanceSuite } from './suite.ts';

/** The Node adapter must pass the same suite a future IndexedDB adapter will. */
runConformanceSuite({
  name: 'node-sqlite',
  create: async (schema) => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-conf-'));
    return new SqliteRecordStore(join(dir, 'store.sqlite'), schema);
  },
});
