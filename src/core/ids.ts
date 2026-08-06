import { sha256Hex, sha256HexOfStrings, uuidV4 } from './sha256.ts';

/** Stable per-occurrence identity. Never derived from content. */
export function newUuid(): string { return uuidV4(); }

/**
 * Deterministic idempotency key. Same logical act -> same key, so a retried
 * Retain after a partial failure does not create a duplicate Transition.
 */
export function idempotencyKey(...parts: string[]): string {
  return 'ik_' + sha256HexOfStrings(parts).slice(0, 32);
}

/** Deterministic content identity. Answers "are these bytes identical?" */
export const CONTENT_HASH_ALGORITHM = 'sha256';
export function contentHash(bytes: Uint8Array): string { return sha256Hex(bytes); }
