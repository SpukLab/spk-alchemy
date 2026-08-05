import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The canonical core must not depend on Node, the filesystem, SQL or any
 * storage engine. This is the structural guarantee behind portability: if it
 * fails, the browser adapter is impossible regardless of what the ADR claims.
 */
const PORTABLE_DIRS = [
  'src/core', 'src/persistence', 'src/registries', 'src/query',
  'src/domain', 'src/audio',
];
const FORBIDDEN = [
  'node:sqlite', 'node:fs', 'node:path', 'node:os', 'node:process',
  'better-sqlite3', 'indexeddb', 'localstorage',
];

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith('.ts')) yield full;
  }
}

test('canonical core has no Node, filesystem, SQL or engine dependency', async () => {
  const offenders: string[] = [];
  for (const dir of PORTABLE_DIRS) {
    for await (const file of walk(dir)) {
      const source = await readFile(file, 'utf8');
      for (const line of source.split('\n')) {
        const m = /^\s*import[^'"]*['"]([^'"]+)['"]/.exec(line);
        if (!m) continue;
        const spec = m[1]!.toLowerCase();
        if (FORBIDDEN.some((f) => spec === f || spec.startsWith(`${f}/`))) {
          offenders.push(`${file}: ${spec}`);
        }
      }
      // node:crypto is permitted: hashing and UUIDs have Web Crypto equivalents.
      // Match SQL syntax, not prose. An English sentence containing the word
      // "select" is not a SQL leak; `SELECT ... FROM` is.
      assert.ok(!/\bSELECT\b[\s\S]{0,200}?\bFROM\b|\bINSERT\s+INTO\b|\bCREATE\s+TABLE\b|\bDELETE\s+FROM\b|\bUPDATE\b[\s\S]{0,80}?\bSET\b/.test(source),
        `${file} must not contain SQL`);
    }
  }
  assert.deepEqual(offenders, [], 'portable layers must not import storage engines');
});

test('adapters are the only place that import storage engines', async () => {
  const source = await readFile('src/adapters/node-sqlite/record-store.ts', 'utf8');
  assert.ok(source.includes("from 'node:sqlite'"), 'adapter owns the engine dependency');
});

test('traversal uses no recursive SQL and no engine recursion', async () => {
  const source = await readFile('src/query/traversal.ts', 'utf8');
  assert.ok(!/WITH\s+RECURSIVE/i.test(source));
  assert.ok(!/\bCTE\b/i.test(source));
  assert.ok(source.includes('adjacencyBySource') && source.includes('adjacencyByTarget'));
});

test('domain logic holds no long-lived or interactive transaction', async () => {
  const source = await readFile('src/domain/alchemy/service.ts', 'utf8');
  // SQL transaction control and interactive transaction handles are the two
  // shapes IndexedDB cannot reproduce. `commit(batch)` is the bounded
  // primitive itself, so it is expected and must not be flagged.
  assert.ok(!/\bBEGIN\b|\bROLLBACK\b|\bBEGIN IMMEDIATE\b/.test(source),
    'no SQL transaction control in the domain');
  assert.ok(!/\.transaction\(|beginTransaction|withTransaction/.test(source),
    'no interactive transaction handle in the domain');
  const writeCalls = source.match(/#records\.commit\(/g) ?? [];
  assert.ok(writeCalls.length > 0, 'the domain writes through the batch primitive');
  // Every commit argument is a precomputed array or variable, never a callback.
  assert.ok(!/#records\.commit\(\s*(async\s*)?\(/.test(source),
    'commit never receives a callback that would run logic inside a transaction');
});

test('no new structural primitive is introduced', async () => {
  // The five canonical primitives are fixed by ADR-005. Adding a sixth
  // collection or a parallel root model would violate it.
  const primitives = await readFile('src/core/primitives.ts', 'utf8');
  const collections = [...primitives.matchAll(/^\s{2}(\w+):\s*'(\w+)',$/gm)].map((m) => m[2]);
  assert.deepEqual(collections.sort(),
    ['agents', 'entities', 'knowledge', 'meta', 'relationships', 'transitions'],
    'exactly the five primitives plus meta');

  // ResearchConfiguration and Preview Set must not become persisted roots.
  const schema = await readFile('src/persistence/schema.ts', 'utf8');
  for (const forbidden of ['configurations', 'previewSets', 'preview_sets', 'comparisonGroups']) {
    assert.ok(!schema.includes(forbidden),
      `${forbidden} must not be a persisted collection`);
  }
  const exploration = await readFile('src/domain/alchemy/exploration.ts', 'utf8');
  assert.ok(!/RECORD|COLLECTIONS|commit\(/.test(exploration),
    'the Preview Set model is runtime-only and never writes records');
});

test('exploration layers introduce no Node or UI dependency', async () => {
  for (const file of [
    'src/audio/operations.ts',
    'src/domain/alchemy/research-configuration.ts',
    'src/domain/alchemy/exploration.ts',
  ]) {
    const source = await readFile(file, 'utf8');
    for (const spec of ['node:fs', 'node:path', 'node:os', 'node:sqlite', 'document', 'window']) {
      assert.ok(!new RegExp(`from '${spec}'|\\b${spec}\\.`).test(source),
        `${file} must not depend on ${spec}`);
    }
    // Strip comments first: a comment saying "no Math.random" is documentation,
    // not a call. The rule is about executable code.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/Math\.random\s*\(/.test(code),
      `${file} must not use unseeded randomness`);
  }
});
