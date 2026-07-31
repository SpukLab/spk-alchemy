import { randomUUID, createHash } from 'node:crypto';

/** Stable per-occurrence identity. Never derived from content. */
export function newUuid(): string { return randomUUID(); }

/**
 * Deterministic idempotency key. Same logical act -> same key, so a retried
 * Retain after a partial failure does not create a duplicate Transition.
 */
export function idempotencyKey(...parts: string[]): string {
  const h = createHash('sha256');
  for (const p of parts) { h.update(p); h.update('\u0000'); }
  return 'ik_' + h.digest('hex').slice(0, 32);
}

/** Deterministic content identity. Answers "are these bytes identical?" */
export const CONTENT_HASH_ALGORITHM = 'sha256';
export function contentHash(bytes: Uint8Array): string {
  return createHash(CONTENT_HASH_ALGORITHM).update(bytes).digest('hex');
}
