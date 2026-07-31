import { mkdir, readFile, writeFile, rename, stat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ContentStore, ContentStat } from '../../persistence/content-store.ts';
import { contentHash } from '../../core/ids.ts';

/** Content-addressed filesystem store: content/<hash[0:2]>/<hash>. */
export class FsContentStore implements ContentStore {
  readonly #root: string;
  constructor(root: string) { this.#root = root; }

  #path(hash: string): string { return join(this.#root, hash.slice(0, 2), hash); }

  async put(bytes: Uint8Array): Promise<ContentStat> {
    const hash = contentHash(bytes);
    const target = this.#path(hash);
    const existing = await this.stat(hash);
    if (existing) return existing; // idempotent by construction
    await mkdir(join(this.#root, hash.slice(0, 2)), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, target); // atomic within the filesystem
    return { hash, size: bytes.byteLength };
  }

  async get(hash: string): Promise<Uint8Array | null> {
    try { return new Uint8Array(await readFile(this.#path(hash))); }
    catch { return null; }
  }

  async has(hash: string): Promise<boolean> { return (await this.stat(hash)) !== null; }

  async stat(hash: string): Promise<ContentStat | null> {
    try { const s = await stat(this.#path(hash)); return { hash, size: s.size }; }
    catch { return null; }
  }

  async list(): Promise<string[]> {
    const out: string[] = [];
    let prefixes: string[];
    try { prefixes = await readdir(this.#root); } catch { return out; }
    for (const p of prefixes) {
      try { for (const f of await readdir(join(this.#root, p))) {
        if (!f.endsWith('.tmp')) out.push(f);
      } } catch { /* not a directory */ }
    }
    return out.sort();
  }

  /** Maintenance only. Never called by domain paths. */
  async remove(hash: string): Promise<void> {
    await rm(this.#path(hash), { force: true });
  }

  async close(): Promise<void> { /* nothing to release */ }
}
