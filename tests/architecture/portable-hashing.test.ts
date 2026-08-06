import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { sha256Hex } from '../../src/core/sha256.ts';
import { contentHash, newUuid, idempotencyKey } from '../../src/core/ids.ts';

/**
 * The pure implementation must be byte-identical to node:crypto. Any divergence
 * would silently invalidate every content hash already stored in the corpus.
 */
test('pure SHA-256 matches node:crypto exactly', () => {
  const cases: Uint8Array[] = [
    new Uint8Array(0),
    new TextEncoder().encode('a'),
    new TextEncoder().encode('abc'),
    new TextEncoder().encode('The quick brown fox jumps over the lazy dog'),
    new TextEncoder().encode('𝄞 unicode beyond the BMP \u0000 with control bytes'),
    new Uint8Array(55).fill(0x61),    // one byte below a padding boundary
    new Uint8Array(56).fill(0x62),    // exactly at the boundary
    new Uint8Array(64).fill(0x63),    // exactly one block
    new Uint8Array(1000).fill(0xff),  // multi-block
  ];
  for (const input of cases) {
    const expected = createHash('sha256').update(input).digest('hex');
    assert.equal(sha256Hex(input), expected, `mismatch for ${input.length} bytes`);
    assert.equal(contentHash(input), expected);
  }
});

test('pure SHA-256 matches node:crypto on pseudo-random payloads', () => {
  let seed = 12345;
  for (let round = 0; round < 40; round++) {
    const length = (seed % 3000) + 1;
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      bytes[i] = seed & 0xff;
    }
    assert.equal(sha256Hex(bytes), createHash('sha256').update(bytes).digest('hex'));
  }
});

test('UUIDs are well-formed v4 and unique', () => {
  const pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const seen = new Set<string>();
  for (let i = 0; i < 500; i++) {
    const id = newUuid();
    assert.match(id, pattern);
    seen.add(id);
  }
  assert.equal(seen.size, 500, 'no collisions');
  assert.match(randomUUID(), pattern, 'same shape as the platform implementation');
});

test('idempotency keys are deterministic and separator-safe', () => {
  assert.equal(idempotencyKey('retain', 'abc'), idempotencyKey('retain', 'abc'));
  assert.notEqual(idempotencyKey('retain', 'abc'), idempotencyKey('retain', 'abd'));
  // Concatenation must not be ambiguous across part boundaries.
  assert.notEqual(idempotencyKey('a', 'bc'), idempotencyKey('ab', 'c'));
  assert.match(idempotencyKey('x'), /^ik_[0-9a-f]{32}$/);
});
