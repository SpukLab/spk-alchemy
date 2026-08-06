import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeImportedFile, describeImportCandidate, ImportDecodeError, IMPORT_ACCEPT_HINT,
} from '../../src/adapters/web-audio/import-decode-policy.ts';
import { detectRecorderCapability } from '../../src/adapters/web-audio/capture-format-policy.ts';
import { decodeWav } from '../../src/audio/wav.ts';
import { IndexedDbRecordStore } from '../../src/adapters/indexeddb/record-store.ts';
import { IndexedDbContentStore } from '../../src/adapters/indexeddb/content-store.ts';
import { DataRegistry } from '../../src/registries/data-registry.ts';
import { registerAlchemyVocabulary } from '../../src/domain/alchemy/vocabulary.ts';
import { AlchemyService } from '../../src/domain/alchemy/service.ts';
import { AlchemyQueries } from '../../src/query/queries.ts';
import { CURRENT_SCHEMA } from '../../src/migrations/index.ts';
import { FRAGMENT_EXPLORATION_V1 } from '../../src/domain/alchemy/research-configuration.ts';
import { COLLECTIONS } from '../../src/core/primitives.ts';

/**
 * The real-device defect: WAV/AIFF files exported from Sound Forge could not
 * be SELECTED in Safari's file picker, because the `accept` attribute governed
 * selection via the capture codec list. ImportDecodePolicy is deliberately
 * independent of CaptureFormatPolicy — these tests exist to keep that true.
 */

/** Stand-in for AudioContext.decodeAudioData with deterministic content. */
function fakeContext(channels: number, frames: number, rate = 44100) {
  return () => ({
    decodeAudioData: async () => ({
      numberOfChannels: channels, length: frames, sampleRate: rate,
      getChannelData: (c: number) => {
        const out = new Float32Array(frames);
        for (let i = 0; i < frames; i++) {
          out[i] = Math.sin((2 * Math.PI * (220 + c * 55) * i) / rate) * 0.7;
        }
        return out;
      },
    }),
    close: () => {},
  });
}

function failingContext(message: string) {
  return () => ({
    decodeAudioData: async () => { throw new DOMException(message, 'EncodingError'); },
    close: () => {},
  });
}

test('1. WAV file with a normal MIME type decodes', async () => {
  const hint = describeImportCandidate({ name: 'texture.wav', type: 'audio/wav' });
  assert.equal(hint.recognized, true);
  const bytes = await decodeImportedFile('texture.wav', new ArrayBuffer(8), fakeContext(1, 2000));
  assert.equal(decodeWav(bytes).samples.length, 2000);
});

test('2. WAV file with empty file.type still decodes', async () => {
  // The exact defect: many third-party exports report an empty or unrecognised
  // MIME. Extension is a hint, decode is authoritative — this must succeed.
  const hint = describeImportCandidate({ name: 'forge-export.wav', type: '' });
  assert.equal(hint.recognized, true, 'extension alone is enough to look plausible');
  const bytes = await decodeImportedFile('forge-export.wav', new ArrayBuffer(8), fakeContext(2, 1500));
  assert.ok(decodeWav(bytes).samples.length > 0);
});

test('3. AIFF file with a normal MIME type decodes', async () => {
  const hint = describeImportCandidate({ name: 'field-recording.aiff', type: 'audio/aiff' });
  assert.equal(hint.recognized, true);
  const bytes = await decodeImportedFile('field-recording.aiff', new ArrayBuffer(8), fakeContext(1, 1800));
  assert.ok(decodeWav(bytes).samples.length > 0);
});

test('4. AIFF file with empty or unusual MIME type still decodes', async () => {
  for (const type of ['', 'application/octet-stream']) {
    const hint = describeImportCandidate({ name: 'take-03.aif', type });
    assert.equal(hint.recognized, true, `extension carries it for type=${JSON.stringify(type)}`);
    const bytes = await decodeImportedFile('take-03.aif', new ArrayBuffer(8), fakeContext(1, 1200));
    assert.ok(decodeWav(bytes).samples.length > 0);
  }
});

test('5. existing ALAC/M4A import keeps working', async () => {
  const hint = describeImportCandidate({ name: 'clip.m4a', type: 'audio/mp4' });
  assert.equal(hint.recognized, true);
  const bytes = await decodeImportedFile('clip.m4a', new ArrayBuffer(8), fakeContext(2, 900));
  assert.ok(decodeWav(bytes).samples.length > 0);
});

test('6. an unsupported or corrupted file fails with a specific, named error', async () => {
  await assert.rejects(
    () => decodeImportedFile('broken.wav', new ArrayBuffer(8), failingContext('Unable to decode audio data')),
    (err: unknown) => {
      assert.ok(err instanceof ImportDecodeError);
      assert.match(err.message, /broken\.wav/, 'the file name is named in the error');
      assert.equal(err.filename, 'broken.wav');
      return true;
    },
  );
});

async function freshLab() {
  const n = Math.trunc(performance.now() * 1000);
  const records = await IndexedDbRecordStore.open(`import-test-${n}`, CURRENT_SCHEMA);
  await records.setSchemaVersion(CURRENT_SCHEMA.version);
  const content = await IndexedDbContentStore.open(`import-content-${n}`);
  const registry = new DataRegistry();
  registerAlchemyVocabulary(registry);
  const service = new AlchemyService(records, content, registry);
  const queries = new AlchemyQueries(records, content);
  const artist = await service.registerAgent({ kind: 'human', name: 'artist', version: '1' });
  const analyzer = await service.registerAgent({
    kind: 'analyzer', name: 'physical-analyzer', version: '1.0.0' });
  return { records, content, service, queries, artist, analyzer };
}

/** Mirrors WebLab.importFile without pulling in browser globals. */
async function importViaLab(lab: Awaited<ReturnType<typeof freshLab>>, filename: string, ctx: () => {
  decodeAudioData: () => Promise<{
    numberOfChannels: number; length: number; sampleRate: number;
    getChannelData(c: number): Float32Array;
  }>;
}) {
  const { decodeImportedFile } = await import('../../src/adapters/web-audio/import-decode-policy.ts');
  const { ANALYZER_V1 } = await import('../../src/audio/analyzer.ts');
  const bytes = await decodeImportedFile(filename, new ArrayBuffer(8), ctx, { channels: 1, maxSeconds: 120 });
  const material = await lab.service.importMaterial({
    bytes, filename: filename.replace(/\.[^.]+$/, '') + '.wav', agentId: lab.artist.id });
  await lab.service.analyzeMaterial(material.id, ANALYZER_V1, lab.analyzer.id);
  return material;
}

test('7. a decode failure leaves IndexedDB completely unchanged', async () => {
  const lab = await freshLab();
  const before = await lab.records.scan(COLLECTIONS.entities, null, 500);
  await assert.rejects(() => importViaLab(lab, 'corrupt.wav', failingContext('bad data')));
  const after = await lab.records.scan(COLLECTIONS.entities, null, 500);
  assert.equal(after.items.length, before.items.length, 'no partial Entity was created');
  const knowledge = await lab.records.scan(COLLECTIONS.knowledge, null, 500);
  assert.equal(knowledge.items.length, 0, 'no Observation either');
  await lab.records.close(); await lab.content.close();
});

test('8. a successfully imported file can enter Exploration', async () => {
  const lab = await freshLab();
  const material = await importViaLab(lab, 'source.wav', fakeContext(1, 4000));

  const intent = await lab.service.createResearchIntent({
    question: 'Exploración libre', agentId: lab.artist.id });
  const set = await lab.service.runResearchConfiguration({
    materialId: material.id, configuration: FRAGMENT_EXPLORATION_V1,
    researchIntentId: intent.id, baseSeed: 777, variationCount: 8, agentId: lab.artist.id });
  assert.equal(set.variations.length, 8);
  assert.equal(new Set(set.variations.map((v) => v.preview.contentHash)).size, 8);
  await lab.records.close(); await lab.content.close();
});

test('9. an imported material survives reload', async () => {
  const n = Math.trunc(performance.now() * 1000);
  const dbName = `reload-records-${n}`;
  const contentName = `reload-content-${n}`;

  const records1 = await IndexedDbRecordStore.open(dbName, CURRENT_SCHEMA);
  await records1.setSchemaVersion(CURRENT_SCHEMA.version);
  const content1 = await IndexedDbContentStore.open(contentName);
  const registry1 = new DataRegistry();
  registerAlchemyVocabulary(registry1);
  const service1 = new AlchemyService(records1, content1, registry1);
  const artist1 = await service1.registerAgent({ kind: 'human', name: 'artist', version: '1' });
  const material = await importViaLab(
    { records: records1, content: content1, service: service1, queries: new AlchemyQueries(records1, content1),
      artist: artist1, analyzer: await service1.registerAgent({ kind: 'analyzer', name: 'physical-analyzer', version: '1.0.0' }) },
    'persisted.wav', fakeContext(1, 2000),
  );
  // Imported materials enter as `promoted` already (a deliberate act by a
  // human Agent — see finding F-6), so nothing further is needed here.
  assert.equal(material.lifecycleState, 'promoted');
  await records1.close(); await content1.close();

  // Reopen — same database names, fresh connection, no shared in-memory state.
  const records2 = await IndexedDbRecordStore.open(dbName, CURRENT_SCHEMA);
  const content2 = await IndexedDbContentStore.open(contentName);
  const queries2 = new AlchemyQueries(records2, content2);
  const inv = await queries2.promotedMaterials(undefined, 50);
  assert.ok(inv.items.some((m) => m.id === material.id), 'material found after reopening the store');
  const bytes = await content2.get(String(material.attributes.contentHash));
  assert.ok(bytes && bytes.byteLength > 0, 'audio content also survived reload');
  await records2.close(); await content2.close();
});

test('10. capture-format detection is unaffected and still selects ALAC on the observed device profile', () => {
  // Exact capability profile reported by the real device in M-14: WAV is NOT
  // accepted for recording, but ALAC, generic MP4 and WebM/Opus are.
  const capability = detectRecorderCapability({
    isTypeSupported: (t) =>
      t === 'audio/mp4; codecs=alac' || t === 'audio/mp4' ||
      t === 'audio/webm; codecs=opus' || t === 'audio/webm',
  });
  assert.equal(capability.mimeType, 'audio/mp4; codecs=alac');
  assert.equal(capability.lossless, true);
});

test('the file-picker accept hint includes WAV and AIFF, not just audio/*', () => {
  for (const ext of ['.wav', '.wave', '.aif', '.aiff']) {
    assert.ok(IMPORT_ACCEPT_HINT.includes(ext), `${ext} present in accept hint`);
  }
});
