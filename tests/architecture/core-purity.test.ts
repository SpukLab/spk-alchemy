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
      assert.ok(!/\bSELECT\b|\bINSERT\b|\bCREATE TABLE\b/i.test(source),
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
