import { createZip } from '../../format/zip.ts';
import type { ZipEntry } from '../../format/zip.ts';
import type { DnaPackManifest } from './family-service.ts';

/**
 * Pure packaging: manifest + audio bytes already fetched by FamilyService.publish
 * become an exportable ZIP. No persistence, no I/O, no DSP — publishing is
 * packaging, not processing. Audio bytes pass through unchanged.
 */

const encoder = new TextEncoder();

export function packDirectoryName(manifest: DnaPackManifest): string {
  const safeName = manifest.familyName.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'family';
  return `${safeName}-dna-v${String(manifest.packVersion).padStart(3, '0')}`;
}

export function buildDnaPackZip(
  manifest: DnaPackManifest, audioByMaterialId: ReadonlyMap<string, Uint8Array>,
): Uint8Array {
  const root = packDirectoryName(manifest);
  const entries: ZipEntry[] = [
    { name: `${root}/manifest.json`, data: encoder.encode(JSON.stringify(manifest, null, 2)) },
  ];
  for (const member of manifest.members) {
    const bytes = audioByMaterialId.get(member.materialId);
    if (!bytes) throw new Error(`missing audio bytes for material ${member.materialId}`);
    entries.push({ name: `${root}/audio/${member.filename}`, data: bytes });
  }
  return createZip(entries);
}
