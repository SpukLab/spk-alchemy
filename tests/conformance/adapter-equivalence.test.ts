import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteRecordStore } from '../../src/adapters/node-sqlite/record-store.ts';
import { IndexedDbRecordStore } from '../../src/adapters/indexeddb/record-store.ts';
import type { RecordStore } from '../../src/persistence/record-store.ts';
import { CONFORMANCE_SCHEMA } from './suite.ts';

/**
 * ADR-009 activation criterion 3: observable query, ordering, transaction and
 * traversal semantics must MATCH between adapters. The suite proves each
 * adapter satisfies the contract; this proves they agree with each other.
 */
async function bothStores(): Promise<{ sqlite: RecordStore; idb: RecordStore }> {
  const dir = mkdtempSync(join(tmpdir(), 'spk-equiv-'));
  return {
    sqlite: new SqliteRecordStore(join(dir, 'store.sqlite'), CONFORMANCE_SCHEMA),
    idb: await IndexedDbRecordStore.open(`equiv-${Date.now()}-${Math.trunc(performance.now())}`,
      CONFORMANCE_SCHEMA),
  };
}

const thing = (id: string, group: string, rank: number) =>
  ({ id, group, rank, code: `code-${id}` });

test('both adapters return identical results for the same operations', async () => {
  const { sqlite, idb } = await bothStores();
  // Deliberately adversarial content: unicode beyond the BMP, embedded control
  // bytes, prefix-like strings, negative and identical ranks.
  const records = [
    thing('a', '', 0), thing('b', 'a', -5), thing('c', 'ab', -5),
    thing('d', 'a\u0000b', 3), thing('e', '𝄞clef', 3), thing('f', 'z', 99),
    thing('g', 'a', 7), thing('h', 'a', -5),
  ];
  for (const store of [sqlite, idb]) {
    await store.commit(records.map((r) => ({ op: 'put', collection: 'things', record: r })));
  }

  const queries = [
    { name: 'full range', q: { collection: 'things', index: 'thing_by_group', limit: 50 } },
    { name: 'prefix a', q: { collection: 'things', index: 'thing_by_group', prefix: ['a'], limit: 50 } },
    { name: 'prefix ab', q: { collection: 'things', index: 'thing_by_group', prefix: ['ab'], limit: 50 } },
    { name: 'prefix empty', q: { collection: 'things', index: 'thing_by_group', prefix: [''], limit: 50 } },
    { name: 'prefix bmp', q: { collection: 'things', index: 'thing_by_group', prefix: ['𝄞clef'], limit: 50 } },
    { name: 'compound', q: { collection: 'things', index: 'thing_by_group', prefix: ['a', -5], limit: 50 } },
    { name: 'range', q: { collection: 'things', index: 'thing_by_group', range: { gte: ['a'], lt: ['z'] }, limit: 50 } },
    { name: 'exact code', q: { collection: 'things', index: 'thing_by_code', eq: ['code-a'], limit: 50 } },
  ] as const;

  for (const { name, q } of queries) {
    const a = await sqlite.lookup(q as never);
    const b = await idb.lookup(q as never);
    assert.deepEqual(a.items.map((i) => i.id), b.items.map((i) => i.id),
      `${name}: identical ordering across adapters`);
  }
  await sqlite.close(); await idb.close();
});

test('keyset pagination walks both adapters identically', async () => {
  const { sqlite, idb } = await bothStores();
  const records = Array.from({ length: 23 }, (_, i) =>
    thing(`t${String(i).padStart(2, '0')}`, 'g', i % 5));
  for (const store of [sqlite, idb]) {
    await store.commit(records.map((r) => ({ op: 'put', collection: 'things', record: r })));
  }

  const walk = async (store: RecordStore): Promise<string[]> => {
    const seen: string[] = [];
    let after: readonly (string | number | boolean | null)[] | undefined;
    for (;;) {
      const page = await store.lookup({
        collection: 'things', index: 'thing_by_group', prefix: ['g'], after, limit: 6 });
      seen.push(...page.items.map((i) => i.id));
      if (page.nextAfter === null) break;
      after = page.nextAfter;
    }
    return seen;
  };
  const a = await walk(sqlite);
  const b = await walk(idb);
  assert.equal(a.length, 23, 'every record returned exactly once');
  assert.deepEqual(a, b, 'identical pagination sequence across adapters');
  assert.equal(new Set(b).size, 23);
  await sqlite.close(); await idb.close();
});

test('adjacency traversal agrees across adapters', async () => {
  const { sqlite, idb } = await bothStores();
  const rels = [
    { id: 'r1', source: 'A', target: 'B', type: 'derived_from', createdAt: 10 },
    { id: 'r2', source: 'A', target: 'C', type: 'derived_from', createdAt: 10 },
    { id: 'r3', source: 'A', target: 'D', type: 'other', createdAt: 5 },
    { id: 'r4', source: 'E', target: 'B', type: 'derived_from', createdAt: 20 },
  ];
  for (const store of [sqlite, idb]) {
    await store.commit(rels.map((r) => ({ op: 'put', collection: 'relationships', record: r })));
  }
  const bySource = async (s: RecordStore) =>
    (await s.adjacencyBySource({ nodeId: 'A', type: 'derived_from', limit: 20 }))
      .items.map((i) => i.id);
  const byTarget = async (s: RecordStore) =>
    (await s.adjacencyByTarget({ nodeId: 'B', limit: 20 })).items.map((i) => i.id);

  assert.deepEqual(await bySource(sqlite), await bySource(idb));
  assert.deepEqual(await byTarget(sqlite), await byTarget(idb));
  // Canonical order: createdAt then id, identical in both.
  assert.deepEqual(await bySource(sqlite), ['r1', 'r2']);
  await sqlite.close(); await idb.close();
});

test('failed batches leave no partial state in either adapter', async () => {
  const { sqlite, idb } = await bothStores();
  for (const store of [sqlite, idb]) {
    await store.commit([{ op: 'put', collection: 'things', record: thing('x', 'g', 1) }]);
    await assert.rejects(() => store.commit([
      { op: 'put', collection: 'things', record: { id: 'ok', group: 'g', rank: 2, code: 'fresh' } },
      { op: 'put', collection: 'things', record: { id: 'bad', group: 'g', rank: 3, code: 'code-x' } },
    ]));
    assert.equal(await store.get('things', 'ok'), null);
    assert.equal(await store.get('things', 'bad'), null);
  }
  await sqlite.close(); await idb.close();
});
