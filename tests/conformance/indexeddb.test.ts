import 'fake-indexeddb/auto';
import { IndexedDbRecordStore } from '../../src/adapters/indexeddb/record-store.ts';
import { runConformanceSuite } from './suite.ts';

/**
 * The SAME conformance suite the Node adapter passes, run against IndexedDB.
 *
 * This is the evidence ADR-009's activation criterion asks for: identical
 * expected semantics, no modification to the suite, no adapter-specific
 * allowances. Note the environment caveat recorded in the findings — this uses
 * a spec-compliant IndexedDB implementation in Node, not Safari itself.
 */
let counter = 0;
runConformanceSuite({
  name: 'indexeddb',
  create: async (schema) => {
    counter += 1;
    return IndexedDbRecordStore.open(`conformance-${counter}-${Date.now()}`, schema);
  },
});
