import { IndexedDbRecordStore } from '../adapters/indexeddb/record-store.ts';
import { IndexedDbContentStore } from '../adapters/indexeddb/content-store.ts';
import { DataRegistry } from '../registries/data-registry.ts';
import { registerAlchemyVocabulary, LIFECYCLE } from '../domain/alchemy/vocabulary.ts';
import { AlchemyService } from '../domain/alchemy/service.ts';
import type { Preview } from '../domain/alchemy/service.ts';
import { AlchemyQueries } from '../query/queries.ts';
import { CURRENT_SCHEMA } from '../migrations/index.ts';
import { DEFAULT_FRAGMENT_EXPLORATION } from '../domain/alchemy/research-configuration.ts';
import type { ResearchConfiguration } from '../domain/alchemy/research-configuration.ts';

import type { PreviewSet } from '../domain/alchemy/exploration.ts';
import { normalizeToCanonicalWav } from '../adapters/web-audio/normalize.ts';
import { detectRecorderCapability } from '../adapters/web-audio/capture-format-policy.ts';
import type { RecorderCapability } from '../adapters/web-audio/capture-format-policy.ts';
import { decodeImportedFile } from '../adapters/web-audio/import-decode-policy.ts';
import { ANALYZER_V1 } from '../audio/analyzer.ts';
import type { Entity } from '../core/primitives.ts';
import { FamilyService } from '../domain/alchemy/family-service.ts';
import type { DnaPackManifest, FamilyMember } from '../domain/alchemy/family-service.ts';
import { buildDnaPackZip, packDirectoryName } from '../domain/alchemy/dna-pack.ts';

/**
 * Browser composition root.
 *
 * The ONLY place that knows about IndexedDB and Web Audio. Everything above it
 * is the same canonical core, the same domain service and the same queries the
 * Node CLI uses — which is the whole point of the portable persistence contract.
 */
export interface FamilyExport { filename: string; zip: Uint8Array; manifest: DnaPackManifest }

export interface WebLab {
  recorderCapability: RecorderCapability;
  /** Which exploration configuration new explorations currently use. */
  explorationConfiguration: Pick<ResearchConfiguration, 'id' | 'version'>;
  // Family / DNA Pack curation
  createFamily(name: string, materialIds: readonly string[]): Promise<Entity>;
  listFamilies(): Promise<Entity[]>;
  familyMembers(familyId: string): Promise<FamilyMember[]>;
  addFamilyMember(familyId: string, materialId: string): Promise<void>;
  removeFamilyMember(familyId: string, materialId: string): Promise<void>;
  reorderFamily(familyId: string, orderedMaterialIds: readonly string[]): Promise<void>;
  publishFamily(familyId: string): Promise<FamilyExport>;
  familyPackCount(familyId: string): Promise<number>;
  /** Microphone capture: bytes always come from the CaptureFormatPolicy's chosen encoder. */
  ingest(input: ArrayBuffer, filename: string): Promise<Entity>;
  /** File import: bytes are of unknown, unverified origin. Decode is the only gate. */
  importFile(input: ArrayBuffer, filename: string): Promise<Entity>;
  explore(materialId: string, question: string, variations: number): Promise<PreviewSet>;
  retain(preview: Preview): Promise<Entity>;
  promote(materialId: string): Promise<void>;
  reject(materialId: string): Promise<void>;
  materials(state: string): Promise<Entity[]>;
  material(id: string): Promise<Entity | null>;
  audioFor(material: Entity): Promise<Uint8Array | null>;
}

const DEFAULT_INTENT = 'Exploración libre';

export async function openWebLab(): Promise<WebLab> {
  const records = await IndexedDbRecordStore.open('alchemy-records', CURRENT_SCHEMA);
  if ((await records.schemaVersion()) < CURRENT_SCHEMA.version) {
    await records.setSchemaVersion(CURRENT_SCHEMA.version);
  }
  const content = await IndexedDbContentStore.open('alchemy-content');
  const registry = new DataRegistry();
  registerAlchemyVocabulary(registry);       // no View Registry: data valid without it
  const service = new AlchemyService(records, content, registry);
  const queries = new AlchemyQueries(records, content);
  const families = new FamilyService(records, content, registry);

  const artist = await service.registerAgent({ kind: 'human', name: 'artist', version: '1' });
  const analyzer = await service.registerAgent({
    kind: 'analyzer', name: 'physical-analyzer', version: '1.0.0' });

  /** Research Intent is preserved, but reduced to one optional phrase. */
  const intentCache = new Map<string, string>();
  async function intentFor(question: string): Promise<string> {
    const key = question || DEFAULT_INTENT;
    const cached = intentCache.get(key);
    if (cached) return cached;
    const intent = await service.createResearchIntent({ question: key, agentId: artist.id });
    intentCache.set(key, intent.id);
    return intent.id;
  }

  const audioContext = (rate: number): never => {
    const Ctor = (window as unknown as {
      AudioContext: typeof AudioContext; webkitAudioContext: typeof AudioContext;
    });
    const Impl = Ctor.AudioContext ?? Ctor.webkitAudioContext;
    return new Impl({ sampleRate: rate }) as never;
  };

  return {
    recorderCapability: detectRecorderCapability(),
    explorationConfiguration: {
      id: DEFAULT_FRAGMENT_EXPLORATION.id, version: DEFAULT_FRAGMENT_EXPLORATION.version,
    },

    async ingest(input, filename) {
      // Capture path: bytes are known-good, produced by the encoder this
      // device just chose. Normalise to canonical PCM16 WAV before hashing,
      // analysis or experiment.
      const bytes = await normalizeToCanonicalWav(input, audioContext,
        { channels: 1, maxSeconds: 120 });
      const material = await service.importMaterial({
        bytes, filename: filename.replace(/\.[^.]+$/, '') + '.wav', agentId: artist.id });
      await service.analyzeMaterial(material.id, ANALYZER_V1, analyzer.id);
      return material;
    },

    async importFile(input, filename) {
      // Import path: bytes are of unrecognised origin — a WAV or AIFF from
      // Sound Forge or anywhere else. The only gate is an actual decode
      // attempt; extension and MIME type are never consulted here. A failed
      // decode throws ImportDecodeError before anything is created.
      const bytes = await decodeImportedFile(filename, input, audioContext,
        { channels: 1, maxSeconds: 120 });
      const material = await service.importMaterial({
        bytes, filename: filename.replace(/\.[^.]+$/, '') + '.wav', agentId: artist.id });
      await service.analyzeMaterial(material.id, ANALYZER_V1, analyzer.id);
      return material;
    },

    async explore(materialId, question, variations) {
      return service.runResearchConfiguration({
        materialId, configuration: DEFAULT_FRAGMENT_EXPLORATION,
        researchIntentId: await intentFor(question),
        baseSeed: Date.now() >>> 0, variationCount: variations, agentId: artist.id });
    },

    async retain(preview) { return (await service.retain(preview, artist.id)).material; },
    async promote(materialId) { await service.promote(materialId, artist.id); },
    async reject(materialId) { await service.reject(materialId, artist.id); },

    async materials(state) {
      const page = state === LIFECYCLE.promoted
        ? await queries.promotedMaterials(undefined, 100)
        : await queries.materialsByLifecycle(state, undefined, 100);
      return [...page.items].reverse();       // newest first on a phone
    },
    async material(id) {
      for (const state of [LIFECYCLE.promoted, LIFECYCLE.retained]) {
        const page = await queries.materialsByLifecycle(state, undefined, 200);
        const found = page.items.find((m) => m.id === id);
        if (found) return found;
      }
      return null;
    },
    async audioFor(material) {
      return content.get(String(material.attributes.contentHash));
    },

    async createFamily(name, materialIds) {
      return families.createFamily({ name, materialIds, agentId: artist.id });
    },
    async listFamilies() {
      return families.listFamilies();
    },
    async familyMembers(familyId) {
      return families.listMembers(familyId);
    },
    async addFamilyMember(familyId, materialId) {
      await families.addMember(familyId, materialId, artist.id);
    },
    async removeFamilyMember(familyId, materialId) {
      await families.removeMember(familyId, materialId, artist.id);
    },
    async reorderFamily(familyId, orderedMaterialIds) {
      await families.reorderMembers(familyId, orderedMaterialIds, artist.id);
    },
    async publishFamily(familyId) {
      const { manifest } = await families.publish(familyId, artist.id);
      const audioByMaterialId = new Map<string, Uint8Array>();
      for (const member of manifest.members) {
        const bytes = await families.audioFor(member.materialId);
        if (!bytes) throw new Error(`missing audio for material ${member.materialId}`);
        audioByMaterialId.set(member.materialId, bytes);
      }
      const zip = buildDnaPackZip(manifest, audioByMaterialId);
      return { filename: `${packDirectoryName(manifest)}.zip`, zip, manifest };
    },
    async familyPackCount(familyId) {
      return (await families.listPacks(familyId)).length;
    },
  };
}
