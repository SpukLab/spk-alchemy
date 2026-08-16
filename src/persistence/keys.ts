import { KeyEncodingError } from '../core/errors.ts';

/**
 * Canonical, versioned, order-preserving key encoding.
 *
 * Both SQLite (BLOB comparison is bytewise memcmp) and IndexedDB (binary keys
 * compare bytewise) order the produced byte strings identically, so declared
 * ordering is engine-independent. Native mixed-type ordering is never relied on.
 *
 * Uses only Uint8Array, DataView and TextEncoder/TextDecoder: no Node globals,
 * because this module runs in the browser as part of the canonical core.
 */
export const KEY_ENCODING_VERSION = 1;

export type KeyComponent = string | number | boolean | null;
export type KeyTuple = readonly KeyComponent[];

// Type tags fix cross-type ordering: null < false < true < integer < string.
const TAG_NULL = 0x10;
const TAG_FALSE = 0x18;
const TAG_TRUE = 0x19;
const TAG_INT = 0x20;
const TAG_STR = 0x30;

const INT_OFFSET = 1n << 63n;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}

/** Bytewise comparison, matching memcmp and IndexedDB binary key ordering. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1;
  }
  return a.length === b.length ? 0 : (a.length < b.length ? -1 : 1);
}

function encodeInt(value: number): Uint8Array {
  if (!Number.isInteger(value)) {
    throw new KeyEncodingError(
      `only integer numbers may be key components (got ${value}); ` +
      `timestamps must be numeric epoch milliseconds`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new KeyEncodingError(`integer key component out of safe range: ${value}`);
  }
  const buf = new Uint8Array(9);
  buf[0] = TAG_INT;
  // Offset binary: preserves signed order under unsigned bytewise comparison.
  new DataView(buf.buffer).setBigUint64(1, BigInt(value) + INT_OFFSET);
  return buf;
}

/**
 * Strings: UTF-8, 0x00 escaped as 0x00 0xFF, terminated by 0x00 0x00.
 * The terminator sorts below any escaped NUL, so "" < "\u0000" and "a" < "ab".
 */
function encodeString(value: string): Uint8Array {
  const raw = encoder.encode(value);
  const out: number[] = [TAG_STR];
  for (const byte of raw) {
    if (byte === 0x00) { out.push(0x00, 0xff); } else { out.push(byte); }
  }
  out.push(0x00, 0x00);
  return Uint8Array.from(out);
}

export function encodeKey(tuple: KeyTuple): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const component of tuple) {
    // A missing field is already normalized to null by the adapters' own
    // field extraction (#extract) before it reaches an index entry. This
    // second line of defense treats `undefined` identically: a raw query
    // tuple assembled by hand (a cursor, an optional filter field) must
    // degrade the same way an absent value does, never throw. Encoding
    // undefined as TAG_NULL is safe because it is never distinguished from
    // an explicit null anywhere the encoding is consumed.
    if (component === null || component === undefined) { parts.push(Uint8Array.of(TAG_NULL)); }
    else if (typeof component === 'boolean') {
      parts.push(Uint8Array.of(component ? TAG_TRUE : TAG_FALSE));
    }
    else if (typeof component === 'number') { parts.push(encodeInt(component)); }
    else if (typeof component === 'string') { parts.push(encodeString(component)); }
    else {
      throw new KeyEncodingError(
        `unsupported key component type: ${typeof component} (value: ${String(component)})`);
    }
  }
  return concatBytes(parts);
}

export function decodeKey(buf: Uint8Array): KeyComponent[] {
  const out: KeyComponent[] = [];
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let i = 0;
  while (i < buf.length) {
    const tag = buf[i]!;
    i += 1;
    if (tag === TAG_NULL) { out.push(null); }
    else if (tag === TAG_FALSE) { out.push(false); }
    else if (tag === TAG_TRUE) { out.push(true); }
    else if (tag === TAG_INT) {
      out.push(Number(view.getBigUint64(i) - INT_OFFSET));
      i += 8;
    } else if (tag === TAG_STR) {
      const bytes: number[] = [];
      for (;;) {
        if (i >= buf.length) throw new KeyEncodingError('truncated string component');
        const b = buf[i]!;
        if (b === 0x00) {
          const next = buf[i + 1];
          if (next === 0x00) { i += 2; break; }
          if (next === 0xff) { bytes.push(0x00); i += 2; continue; }
          throw new KeyEncodingError('invalid escape sequence in string component');
        }
        bytes.push(b); i += 1;
      }
      out.push(decoder.decode(Uint8Array.from(bytes)));
    } else {
      throw new KeyEncodingError(`unknown key tag 0x${tag.toString(16)}`);
    }
  }
  return out;
}

/** Smallest byte string strictly greater than every key having `prefix`. */
export function prefixUpperBound(prefix: Uint8Array): Uint8Array | null {
  const out = Uint8Array.from(prefix);
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i]! < 0xff) { out[i] = out[i]! + 1; return out.subarray(0, i + 1); }
  }
  return null; // all 0xff: unbounded above
}

export function compareKeys(a: Uint8Array, b: Uint8Array): number { return compareBytes(a, b); }
