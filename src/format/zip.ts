/**
 * Minimal deterministic ZIP writer — STORE method only (no compression).
 *
 * Zero dependencies, pure Uint8Array manipulation: runs identically in Node
 * and in the browser bundle, which a compression library would jeopardize.
 * Audio is already compact PCM16; skipping compression costs little and keeps
 * the DNA Pack export free of any new dependency, consistent with the rest of
 * this project. Deterministic byte-for-byte output for identical inputs — no
 * timestamps beyond a fixed DOS epoch, no filesystem metadata.
 */

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const encoder = new TextEncoder();

// Fixed DOS date/time (1980-01-01 00:00:00): output must be a pure function
// of the entries, never of wall-clock time.
const DOS_TIME = 0;
const DOS_DATE = 0x21;

function u16(view: DataView, offset: number, value: number): void { view.setUint16(offset, value, true); }
function u32(view: DataView, offset: number, value: number): void { view.setUint32(offset, value, true); }

export function createZip(entries: readonly ZipEntry[]): Uint8Array {
  const nameBytes = entries.map((e) => encoder.encode(e.name));
  const crcs = entries.map((e) => crc32(e.data));

  let localSize = 0;
  for (let i = 0; i < entries.length; i++) localSize += 30 + nameBytes[i]!.length + entries[i]!.data.length;
  let centralSize = 0;
  for (let i = 0; i < entries.length; i++) centralSize += 46 + nameBytes[i]!.length;

  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);
  const offsets: number[] = [];
  let pos = 0;

  for (let i = 0; i < entries.length; i++) {
    offsets.push(pos);
    const name = nameBytes[i]!;
    const data = entries[i]!.data;
    const crc = crcs[i]!;

    u32(view, pos, 0x04034b50); pos += 4;               // local file header signature
    u16(view, pos, 20); pos += 2;                        // version needed
    u16(view, pos, 0); pos += 2;                          // flags
    u16(view, pos, 0); pos += 2;                          // method: STORE
    u16(view, pos, DOS_TIME); pos += 2;
    u16(view, pos, DOS_DATE); pos += 2;
    u32(view, pos, crc); pos += 4;
    u32(view, pos, data.length); pos += 4;                // compressed size
    u32(view, pos, data.length); pos += 4;                // uncompressed size
    u16(view, pos, name.length); pos += 2;
    u16(view, pos, 0); pos += 2;                          // extra field length
    out.set(name, pos); pos += name.length;
    out.set(data, pos); pos += data.length;
  }

  const centralStart = pos;
  for (let i = 0; i < entries.length; i++) {
    const name = nameBytes[i]!;
    const data = entries[i]!.data;
    const crc = crcs[i]!;

    u32(view, pos, 0x02014b50); pos += 4;                 // central directory header signature
    u16(view, pos, 20); pos += 2;                          // version made by
    u16(view, pos, 20); pos += 2;                          // version needed
    u16(view, pos, 0); pos += 2;                            // flags
    u16(view, pos, 0); pos += 2;                            // method
    u16(view, pos, DOS_TIME); pos += 2;
    u16(view, pos, DOS_DATE); pos += 2;
    u32(view, pos, crc); pos += 4;
    u32(view, pos, data.length); pos += 4;
    u32(view, pos, data.length); pos += 4;
    u16(view, pos, name.length); pos += 2;
    u16(view, pos, 0); pos += 2;                            // extra length
    u16(view, pos, 0); pos += 2;                            // comment length
    u16(view, pos, 0); pos += 2;                            // disk number start
    u16(view, pos, 0); pos += 2;                            // internal attributes
    u32(view, pos, 0); pos += 4;                            // external attributes
    u32(view, pos, offsets[i]!); pos += 4;                  // local header offset
    out.set(name, pos); pos += name.length;
  }
  const centralEnd = pos;

  u32(view, pos, 0x06054b50); pos += 4;                    // end of central directory signature
  u16(view, pos, 0); pos += 2;                              // disk number
  u16(view, pos, 0); pos += 2;                              // disk with central directory
  u16(view, pos, entries.length); pos += 2;                 // entries on this disk
  u16(view, pos, entries.length); pos += 2;                 // total entries
  u32(view, pos, centralEnd - centralStart); pos += 4;      // central directory size
  u32(view, pos, centralStart); pos += 4;                   // central directory offset
  u16(view, pos, 0); pos += 2;                              // comment length

  return out;
}
