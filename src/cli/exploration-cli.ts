import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Lab } from './context.ts';
import type { PreviewSet } from '../domain/alchemy/exploration.ts';
import type { Preview } from '../domain/alchemy/service.ts';
import { configurationById } from '../domain/alchemy/research-configuration.ts';

/**
 * Preview Sets are runtime state, but the CLI is one process per command. The
 * manifest is a staging reference on disk that lets `retain` rebuild a Preview
 * from an exported WAV. It is NOT persistence: no canonical record exists until
 * an explicit Retain, and deleting the output directory loses nothing canonical.
 */
export interface ManifestEntry {
  previewId: string;
  variationIndex: number;
  seed: number;
  contentHash: string;
  file: string;
  experimentId: string;
  sourceMaterialIds: string[];
  derivedParameters: Record<string, unknown>;
}

export interface Manifest {
  kind: 'preview-set-manifest';
  configurationId: string;
  configurationVersion: string;
  implementationVersion: string;
  researchIntentId: string;
  sourceMaterialIds: string[];
  baseSeed: number;
  createdAt: number;
  executionAgentId: string;
  entries: ManifestEntry[];
}

export const MANIFEST_NAME = 'manifest.json';

export async function exportPreviewSet(
  set: PreviewSet, outputDir: string,
): Promise<{ manifest: Manifest; path: string }> {
  await mkdir(outputDir, { recursive: true });
  const entries: ManifestEntry[] = [];
  for (const v of set.variations) {
    const file = `v${String(v.index).padStart(2, '0')}-seed${v.seed}.wav`;
    await writeFile(join(outputDir, file), v.preview.bytes);
    entries.push({
      previewId: v.preview.stagingRef, variationIndex: v.index, seed: v.seed,
      contentHash: v.preview.contentHash, file,
      experimentId: v.preview.experimentId,
      sourceMaterialIds: [...v.preview.sourceMaterialIds],
      derivedParameters: v.derivedParameters as unknown as Record<string, unknown>,
    });
  }
  const manifest: Manifest = {
    kind: 'preview-set-manifest',
    configurationId: set.configurationId,
    configurationVersion: set.configurationVersion,
    implementationVersion: set.implementationVersion,
    researchIntentId: set.researchIntentId,
    sourceMaterialIds: [...set.sourceMaterialIds],
    baseSeed: set.baseSeed, createdAt: set.createdAt,
    executionAgentId: set.executionAgentId, entries,
  };
  const path = join(outputDir, MANIFEST_NAME);
  await writeFile(path, JSON.stringify(manifest, null, 2));
  return { manifest, path };
}

export async function readManifest(outputDir: string): Promise<Manifest> {
  return JSON.parse(await readFile(join(outputDir, MANIFEST_NAME), 'utf8')) as Manifest;
}

/**
 * Rebuild a runtime Preview from the manifest and its exported WAV. The bytes
 * come from the exported file and the content hash is re-verified, so a tampered
 * or truncated file cannot be retained silently.
 */
export async function previewFromManifest(
  manifest: Manifest, previewId: string, outputDir: string, lab: Lab,
): Promise<Preview> {
  const entry = manifest.entries.find(
    (e) => e.previewId === previewId || e.previewId.endsWith(previewId));
  if (!entry) throw new Error(`preview ${previewId} not found in manifest`);
  const bytes = new Uint8Array(await readFile(join(outputDir, entry.file)));
  // Pin to the manifest's exact version: an old (1.0.0) manifest must resolve
  // to 1.0.0, never silently to whatever the current default is.
  const cfg = configurationById(manifest.configurationId, manifest.configurationVersion);
  const { contentHash } = await import('../core/ids.ts');
  const actual = contentHash(bytes);
  if (actual !== entry.contentHash) {
    throw new Error(
      `exported preview ${entry.file} no longer matches its manifest hash; refusing to retain`);
  }
  void lab;
  return {
    kind: 'preview',
    stagingRef: entry.previewId,
    experimentId: entry.experimentId,
    sourceMaterialIds: entry.sourceMaterialIds,
    operation: cfg.id,
    parameters: {
      configurationId: cfg.id, configurationVersion: manifest.configurationVersion, seed: entry.seed,
    },
    implementationVersion: manifest.implementationVersion,
    bytes, contentHash: actual,
    exploration: {
      configurationId: manifest.configurationId,
      configurationVersion: manifest.configurationVersion,
      variationIndex: entry.variationIndex, seed: entry.seed,
    },
  };
}
