import { KeyEncodingError } from '../core/errors.ts';

/**
 * Canonical, versioned, order-preserving key encoding.
 *
 * Both SQLite (BLOB comparison is bytewise memcmp) and IndexedDB (binary keys
 * compare bytewise) order the produced byte strings identically, so declared
 * ordering is engine-independent. Native mixed-type ordering is never relied on.
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

function encodeInt(value: number): Buffer {
  if (!Number.isInteger(value)) {
    throw new KeyEncodingError(
      `only integer numbers may be key components (got ${value}); ` +
      `timestamps must be numeric epoch milliseconds`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new KeyEncodingError(`integer key component out of safe range: ${value}`);
  }
  const buf = Buffer.alloc(9);
  buf.writeUInt8(TAG_INT, 0);
  // Offset binary: preserves signed order under unsigned bytewise comparison.
  buf.writeBigUInt64BE(BigInt(value) + INT_OFFSET, 1);
  return buf;
}

/**
 * Strings: UTF-8, 0x00 escaped as 0x00 0xFF, terminated by 0x00 0x00.
 * The terminator sorts below any escaped NUL, so "" < "\u0000" and "a" < "ab".
 */
function encodeString(value: string): Buffer {
  const raw = Buffer.from(value, 'utf8');
  const out: number[] = [TAG_STR];
  for (const byte of raw) {
    if (byte === 0x00) { out.push(0x00, 0xff); } else { out.push(byte); }
  }
  out.push(0x00, 0x00);
  return Buffer.from(out);
}

export function encodeKey(tuple: KeyTuple): Buffer {
  const parts: Buffer[] = [];
  for (const component of tuple) {
    if (component === null) { parts.push(Buffer.from([TAG_NULL])); }
    else if (typeof component === 'boolean') {
      parts.push(Buffer.from([component ? TAG_TRUE : TAG_FALSE]));
    }
    else if (typeof component === 'number') { parts.push(encodeInt(component)); }
    else if (typeof component === 'string') { parts.push(encodeString(component)); }
    else { throw new KeyEncodingError(`unsupported key component type: ${typeof component}`); }
  }
  return Buffer.concat(parts);
}

export function decodeKey(buf: Buffer): KeyComponent[] {
  const out: KeyComponent[] = [];
  let i = 0;
  while (i < buf.length) {
    const tag = buf[i]!;
    i += 1;
    if (tag === TAG_NULL) { out.push(null); }
    else if (tag === TAG_FALSE) { out.push(false); }
    else if (tag === TAG_TRUE) { out.push(true); }
    else if (tag === TAG_INT) {
      const raw = buf.readBigUInt64BE(i);
      i += 8;
      out.push(Number(raw - INT_OFFSET));
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
      out.push(Buffer.from(bytes).toString('utf8'));
    } else {
      throw new KeyEncodingError(`unknown key tag 0x${tag.toString(16)}`);
    }
  }
  return out;
}

/** Smallest byte string strictly greater than every key having `prefix`. */
export function prefixUpperBound(prefix: Buffer): Buffer | null {
  const out = Buffer.from(prefix);
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i]! < 0xff) { out[i] = out[i]! + 1; return out.subarray(0, i + 1); }
  }
  return null; // all 0xff: unbounded above
}

export function compareKeys(a: Buffer, b: Buffer): number { return Buffer.compare(a, b); }
