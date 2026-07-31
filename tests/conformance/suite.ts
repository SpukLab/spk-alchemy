import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RecordStore, StoredRecord } from '../../src/persistence/record-store.ts';
import { MAX_BATCH_MUTATIONS } from '../../src/persistence/record-store.ts';
import type { SchemaDeclaration } from '../../src/persistence/schema.ts';
import { encodeKey, decodeKey } from '../../src/persistence/keys.ts';

/**
 * ONE conformance suite. Every RecordStore adapter must pass it unchanged.
 * A future IndexedDB adapter runs this same file: portability is executable,
 * not aspirational. The suite asserts OBSERVABLE behaviour only — it never
 * inspects an adapter's internal index representation.
 */
export const CONFORMANCE_SCHEMA: SchemaDeclaration = {
  version: 1,
  collections: ['things', 'relationships'],
  indexes: [
    { name: 'thing_by_group', collection: 'things', fields: ['group', 'rank', 'id'] },
    { name: 'thing_by_code', collection: 'things', fields: ['code'], unique: true },
    { name: 'rel_by_source', collection: 'relationships', fields: ['source', 'type', 'createdAt', 'id'] },
    { name: 'rel_by_target', collection: 'relationships', fields: ['target', 'type', 'createdAt', 'id'] },
  ],
};

export interface AdapterFactory {
  name: string;
  create: (schema: SchemaDeclaration) => Promise<RecordStore>;
}

const thing = (id: string, group: string, rank: number, code?: string): StoredRecord =>
  ({ id, group, rank, code: code ?? `code-${id}` });
const rel = (id: string, source: string, target: string, type: string, createdAt: number): StoredRecord =>
  ({ id, source, target, type, createdAt });
const ids = (page: { items: StoredRecord[] }): string[] => page.items.map((i) => i.id);
const asSet = (xs: string[]): string[] => [...xs].sort();

export function runConformanceSuite(factory: AdapterFactory): void {
  const suite = `conformance:${factory.name}`;

  test(`${suite} read by ID and bounded multi-read`, async () => {
    const s = await factory.create(CONFORMANCE_SCHEMA);
    await s.commit([
      { op: 'put', collection: 'things', record: thing('a', 'g1', 1) },
      { op: 'put', collection: 'things', record: thing('b', 'g1', 2) },
    ]);
    assert.equal((await s.get('things', 'a'))?.id, 'a');
    assert.equal(await s.get('things', 'missing'), null, 'missing key returns null, never throws');
    const many = await s.getMany('things', ['a', 'missing', 'b']);
    assert.deepEqual(many.map((m) => m?.id ?? null), ['a', null, 'b']);
    await s.close();
  });

  test(`${suite} bounded atomic batch exposes no partial state on failure`, async () => {
    const s = await factory.create(CONFORMANCE_SCHEMA);
    await s.commit([{ op: 'put', collection: 'things', record: thing('x', 'g', 1, 'dup') }]);
    await assert.rejects(() => s.commit([
      { op: 'put', collection: 'things', record: thing('ok', 'g', 2, 'fresh') },
      { op: 'put', collection: 'things', record: thing('bad', 'g', 3, 'dup') }, // unique clash
    ]));
    assert.equal(await s.get('things', 'ok'), null, 'no mutation from a failed batch is visible');
    assert.equal(await s.get('things', 'bad'), null);
    await s.close();
  });

  test(`${suite} batch size is bounded`, async () => {
    const s = await factory.create(CONFORMANCE_SCHEMA);
    const oversized = Array.from({ length: MAX_BATCH_MUTATIONS + 1 }, (_, i) =>
      ({ op: 'put', collection: 'things', record: thing(`o${i}`, 'g', i) }) as const);
    await assert.rejects(() => s.commit(oversized), /bounded maximum/);
    await s.close();
  });

  test(`${suite} exact, compound, prefix and range lookups`, async () => {
    const s = await factory.create(CONFORMANCE_SCHEMA);
    await s.commit([
      { op: 'put', collection: 'things', record: thing('a', 'alpha', 1) },
      { op: 'put', collection: 'things', record: thing('b', 'alpha', 2) },
      { op: 'put', collection: 'things', record: thing('c', 'beta', 1) },
    ]);
    const exact = await s.lookup({
      collection: 'things', index: 'thing_by_code', eq: ['code-a'], limit: 10 });
    assert.deepEqual(ids(exact), ['a']);
    const prefix = await s.lookup({
      collection: 'things', index: 'thing_by_group', prefix: ['alpha'], limit: 10 });
    assert.deepEqual(ids(prefix), ['a', 'b'], 'prefix confines results to the group');
    const compound = await s.lookup({
      collection: 'things', index: 'thing_by_group', prefix: ['alpha', 2], limit: 10 });
    assert.deepEqual(ids(compound), ['b']);
    const range = await s.lookup({
      collection: 'things', index: 'thing_by_group',
      range: { gte: ['alpha'], lt: ['beta'] }, limit: 10 });
    assert.deepEqual(ids(range), ['a', 'b'], 'range upper bound is exclusive');
    await s.close();
  });

  test(`${suite} keyset pagination returns each record exactly once`, async () => {
    const s = await factory.create(CONFORMANCE_SCHEMA);
    const n = 25;
    await s.commit(Array.from({ length: n }, (_, i) =>
      ({ op: 'put', collection: 'things', record: thing(`t${String(i).padStart(2, '0')}`, 'g', i) }) as const));
    const seen: string[] = [];
    let after: readonly (string | number | boolean | null)[] | undefined;
    for (;;) {
      const page = await s.lookup({
        collection: 'things', index: 'thing_by_group', prefix: ['g'], after, limit: 7 });
      seen.push(...ids(page));
      if (page.nextAfter === null) break;
      after = page.nextAfter;
    }
    assert.equal(seen.length, n, 'no result skipped and none repeated');
    assert.equal(new Set(seen).size, n);
    assert.deepEqual(seen, [...seen].sort(), 'canonical order preserved across pages');
    await s.close();
  });

  test(`${suite} pagination resumes from an arbitrary valid key tuple`, async () => {
    const s = await factory.create(CONFORMANCE_SCHEMA);
    await s.commit(Array.from({ length: 10 }, (_, i) =>
      ({ op: 'put', collection: 'things', record: thing(`t${i}`, 'g', i) }) as const));
    const resumed = await s.lookup({
      collection: 'things', index: 'thing_by_group',
      prefix: ['g'], after: ['g', 6, 't6'], limit: 10 });
    assert.deepEqual(ids(resumed), ['t7', 't8', 't9']);
    await s.close();
  });

  test(`${suite} declared canonical ordering, not engine-native order`, async () => {
    const s = await factory.create(CONFORMANCE_SCHEMA);
    // Inserted out of order and with identical ranks, resolved by the ID tie-break.
    await s.commit([
      { op: 'put', collection: 'things', record: thing('zz', 'g', 5) },
      { op: 'put', collection: 'things', record: thing('aa', 'g', 5) },
      { op: 'put', collection: 'things', record: thing('mm', 'g', 1) },
    ]);
    const page = await s.lookup({
      collection: 'things', index: 'thing_by_group', prefix: ['g'], limit: 10 });
    assert.deepEqual(ids(page), ['mm', 'aa', 'zz'],
      'rank ascending, then ID as the mandatory tie-breaker');
    await s.close();
  });

  test(`${suite} unordered results compare as normalized sets`, async () => {
    const s = await factory.create(CONFORMANCE_SCHEMA);
    await s.commit([
      { op: 'put', collection: 'relationships', record: rel('r1', 'n1', 'n2', 'x', 10) },
      { op: 'put', collection: 'relationships', record: rel('r2', 'n1', 'n3', 'x', 10) },
    ]);
    const page = await s.adjacencyBySource({ nodeId: 'n1', limit: 10 });
    assert.deepEqual(asSet(ids(page)), ['r1', 'r2']);
    await s.close();
  });

  test(`${suite} duplicate-key semantics on unique indexes`, async () => {
    const s = await factory.create(CONFORMANCE_SCHEMA);
    await s.commit([{ op: 'put', collection: 'things', record: thing('a', 'g', 1, 'shared') }]);
    await assert.rejects(
      () => s.commit([{ op: 'put', collection: 'things', record: thing('b', 'g', 2, 'shared') }]),
      (err: Error & { code?: string }) => err.code === 'UNIQUENESS');
    // Re-putting the SAME record under its own unique key must succeed.
    await s.commit([{ op: 'put', collection: 'things', record: thing('a', 'g', 9, 'shared') }]);
    assert.equal((await s.get('things', 'a'))?.rank, 9);
    await s.close();
  });

  test(`${suite} index visibility and obsolete values after update`, async () => {
    const s = await factory.create(CONFORMANCE_SCHEMA);
    await s.commit([{ op: 'put', collection: 'things', record: thing('a', 'old', 1) }]);
    assert.deepEqual(ids(await s.lookup({
      collection: 'things', index: 'thing_by_group', prefix: ['old'], limit: 10 })), ['a']);
    await s.commit([{ op: 'put', collection: 'things', record: thing('a', 'new', 1) }]);
    assert.deepEqual(ids(await s.lookup({
      collection: 'things', index: 'thing_by_group', prefix: ['new'], limit: 10 })), ['a'],
      'new index value visible immediately after commit');
    assert.deepEqual(ids(await s.lookup({
      collection: 'things', index: 'thing_by_group', prefix: ['old'], limit: 10 })), [],
      'obsolete index value disappears');
    await s.commit([{ op: 'delete', collection: 'things', id: 'a' }]);
    assert.deepEqual(ids(await s.lookup({
      collection: 'things', index: 'thing_by_group', prefix: ['new'], limit: 10 })), []);
    await s.close();
  });

  test(`${suite} adjacency by source and by target`, async () => {
    const s = await factory.create(CONFORMANCE_SCHEMA);
    await s.commit([
      { op: 'put', collection: 'relationships', record: rel('r1', 'A', 'B', 'derived_from', 1) },
      { op: 'put', collection: 'relationships', record: rel('r2', 'C', 'B', 'derived_from', 2) },
      { op: 'put', collection: 'relationships', record: rel('r3', 'A', 'D', 'other', 3) },
    ]);
    assert.deepEqual(asSet(ids(await s.adjacencyBySource({ nodeId: 'A', limit: 10 }))), ['r1', 'r3']);
    assert.deepEqual(ids(await s.adjacencyBySource({
      nodeId: 'A', type: 'derived_from', limit: 10 })), ['r1'], 'type filter applies as key prefix');
    assert.deepEqual(asSet(ids(await s.adjacencyByTarget({ nodeId: 'B', limit: 10 }))), ['r1', 'r2']);
    await s.close();
  });

  test(`${suite} migration version inspection`, async () => {
    const s = await factory.create(CONFORMANCE_SCHEMA);
    assert.equal(typeof (await s.schemaVersion()), 'number');
    await s.close();
  });

  test(`${suite} adversarial canonical key cases`, async () => {
    const s = await factory.create(CONFORMANCE_SCHEMA);
    const cases: string[] = [
      '',            // empty component
      'a', 'ab',     // one string is a prefix of another
      'a\u0000b',    // embedded NUL
      'a\u0001b',    // embedded control byte
      '𝄞clef',       // outside the BMP
      'z',
    ];
    await s.commit(cases.map((c, i) =>
      ({ op: 'put', collection: 'things', record: { id: `k${i}`, group: c, rank: 0, code: `c${i}` } }) as const));
    // Each distinct string must be independently addressable: no collisions,
    // and a prefix-like value must not leak into its neighbour's results.
    for (let i = 0; i < cases.length; i++) {
      const page = await s.lookup({
        collection: 'things', index: 'thing_by_group', prefix: [cases[i]!], limit: 10 });
      assert.deepEqual(ids(page), [`k${i}`], `prefix isolation for ${JSON.stringify(cases[i])}`);
    }
    // Signed integers must order numerically, not lexicographically.
    await s.commit([
      { op: 'put', collection: 'things', record: { id: 'n1', group: 'ints', rank: -100, code: 'n1' } },
      { op: 'put', collection: 'things', record: { id: 'n2', group: 'ints', rank: -1, code: 'n2' } },
      { op: 'put', collection: 'things', record: { id: 'n3', group: 'ints', rank: 0, code: 'n3' } },
      { op: 'put', collection: 'things', record: { id: 'n4', group: 'ints', rank: 9, code: 'n4' } },
    ]);
    assert.deepEqual(ids(await s.lookup({
      collection: 'things', index: 'thing_by_group', prefix: ['ints'], limit: 10 })),
      ['n1', 'n2', 'n3', 'n4'], 'negative integers sort below positive ones');
    // Identical timestamps resolved by ID.
    await s.commit([
      { op: 'put', collection: 'relationships', record: rel('rb', 'S', 'T', 't', 500) },
      { op: 'put', collection: 'relationships', record: rel('ra', 'S', 'T', 't', 500) },
    ]);
    assert.deepEqual(ids(await s.adjacencyBySource({ nodeId: 'S', limit: 10 })), ['ra', 'rb']);
    await s.close();
  });

  test(`${suite} key encoding round-trips`, () => {
    const tuples = [
      ['', 0], ['a\u0000b', -1], ['𝄞', 9007199254740991], [null, true, false, 'x'],
    ] as const;
    for (const t of tuples) {
      assert.deepEqual(decodeKey(encodeKey(t as never)), [...t]);
    }
  });
}
