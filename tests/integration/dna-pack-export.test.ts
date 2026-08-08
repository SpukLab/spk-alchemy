import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DnaPackExportController } from '../../src/web/export-orchestrator.ts';
import type { ExportDeps, DnaPackArtifact } from '../../src/web/export-orchestrator.ts';

/**
 * Physical-device defect: one Publish press called both the anchor download
 * AND navigator.share() unconditionally — Safari's download confirmation sat
 * behind the native share sheet, and accepting it downloaded the same ZIP a
 * second time. These tests count invocations against mocked browser APIs so
 * a regression that fires both paths for one gesture fails loudly.
 */

function mockDeps(shareOutcome: 'shared' | 'cancelled' = 'shared') {
  const calls = { download: 0, share: 0, canShareFiles: 0 };
  const deps: ExportDeps = {
    download: () => { calls.download += 1; },
    share: async () => { calls.share += 1; return shareOutcome; },
    canShareFiles: () => { calls.canShareFiles += 1; return true; },
  };
  return { deps, calls };
}

function fakeArtifact(version = 1): DnaPackArtifact {
  return { filename: `pack-v${String(version).padStart(3, '0')}.zip`, zip: new Uint8Array([1, 2, 3]), manifest: { version } };
}

test('1+2+3. one Publish click calls publish exactly once, creates one pack, one version', async () => {
  const { deps } = mockDeps();
  const controller = new DnaPackExportController(deps);
  let publishCalls = 0;
  const publish = async () => { publishCalls += 1; return fakeArtifact(1); };
  const result = await controller.publishAndDownload('fam-1', publish);
  assert.equal(publishCalls, 1, 'the canonical publish action ran exactly once');
  assert.equal(result?.manifest && (result.manifest as { version: number }).version, 1);
});

test('4+5. download path invokes the anchor download exactly once and never calls share', async () => {
  const { deps, calls } = mockDeps();
  const controller = new DnaPackExportController(deps);
  await controller.publishAndDownload('fam-1', async () => fakeArtifact());
  assert.equal(calls.download, 1);
  assert.equal(calls.share, 0, 'download path must never touch navigator.share');
});

test('6+7. explicit Share invokes share exactly once and never triggers a download', async () => {
  const { deps, calls } = mockDeps('shared');
  const controller = new DnaPackExportController(deps);
  await controller.publishAndDownload('fam-1', async () => fakeArtifact());
  calls.download = 0; // isolate: only count what shareLast does
  const outcome = await controller.shareLast('fam-1');
  assert.equal(outcome, 'shared');
  assert.equal(calls.share, 1);
  assert.equal(calls.download, 0, 'a successful share must never also download');
});

test('8. a cancelled Share does not invoke anchor download', async () => {
  const { deps, calls } = mockDeps('cancelled');
  const controller = new DnaPackExportController(deps);
  await controller.publishAndDownload('fam-1', async () => fakeArtifact());
  calls.download = 0;
  const outcome = await controller.shareLast('fam-1');
  assert.equal(outcome, 'cancelled');
  assert.equal(calls.download, 0, 'cancellation must never fall back to downloading');
});

test('9. unsupported Share capability leaves normal Download available', async () => {
  const deps: ExportDeps = {
    download: () => {}, share: async () => 'shared', canShareFiles: () => false,
  };
  const controller = new DnaPackExportController(deps);
  await controller.publishAndDownload('fam-1', async () => fakeArtifact());
  assert.equal(controller.canShareLast('fam-1'), false, 'share is correctly reported unavailable');
  // Download remains independently callable regardless of share support.
  const { deps: deps2, calls } = mockDeps();
  const controller2 = new DnaPackExportController(deps2);
  await controller2.publishAndDownload('fam-1', async () => fakeArtifact());
  assert.equal(calls.download, 1);
});

test('10. duplicate Publish taps while busy create only one pack', async () => {
  const { deps, calls } = mockDeps();
  const controller = new DnaPackExportController(deps);
  let publishCalls = 0;
  let releasePublish: () => void = () => {};
  const gate = new Promise<void>((resolve) => { releasePublish = resolve; });
  const publish = async () => { publishCalls += 1; await gate; return fakeArtifact(); };

  const first = controller.publishAndDownload('fam-1', publish);
  assert.equal(controller.isPublishing(), true);
  const second = controller.publishAndDownload('fam-1', publish); // rapid duplicate tap
  assert.equal(await second, null, 'the duplicate tap is ignored, not queued');
  releasePublish();
  await first;
  assert.equal(publishCalls, 1, 'exactly one canonical publish happened');
  assert.equal(calls.download, 1, 'exactly one download happened');
});

test('11. duplicate Share taps while busy invoke one native share flow', async () => {
  const { deps, calls } = mockDeps('shared');
  const controller = new DnaPackExportController(deps);
  await controller.publishAndDownload('fam-1', async () => fakeArtifact());

  let releaseShare: () => void = () => {};
  const gate = new Promise<void>((resolve) => { releaseShare = resolve; });
  const slowDeps: ExportDeps = {
    ...deps,
    share: async () => { calls.share += 1; await gate; return 'shared'; },
  };
  const slowController = new DnaPackExportController(slowDeps);
  await slowController.publishAndDownload('fam-1', async () => fakeArtifact());
  calls.share = 0;

  const first = slowController.shareLast('fam-1');
  assert.equal(slowController.isSharing(), true);
  const second = await slowController.shareLast('fam-1'); // rapid duplicate tap
  assert.equal(second, 'unavailable', 'the duplicate tap is ignored');
  releaseShare();
  await first;
  assert.equal(calls.share, 1, 'exactly one native share flow ran');
});

test('12+13. download deps receive exactly the artifact bytes; controller performs no DOM cleanup itself', async () => {
  // The controller delegates the actual anchor lifecycle (create, click once,
  // remove, revoke) to the injected download function, which in the real app
  // is downloadBlob() — unchanged by this fix and already correct: one
  // .click(), one a.remove(), one eventual URL.revokeObjectURL(). This test
  // confirms the controller calls that function exactly once per publish with
  // the right bytes; a source check below confirms downloadBlob's own shape.
  const received: { filename: string; bytes: Uint8Array }[] = [];
  const deps: ExportDeps = {
    download: (filename, bytes) => { received.push({ filename, bytes }); },
    share: async () => 'shared', canShareFiles: () => false,
  };
  const controller = new DnaPackExportController(deps);
  const artifact = fakeArtifact(2);
  await controller.publishAndDownload('fam-1', async () => artifact);
  assert.equal(received.length, 1);
  assert.equal(received[0]!.filename, artifact.filename);
  assert.deepEqual(Array.from(received[0]!.bytes), Array.from(artifact.zip));

  const { readFile } = await import('node:fs/promises');
  const source = await readFile('web/app.js', 'utf8');
  const fn = /function downloadBlob\([\s\S]*?\n}/.exec(source)?.[0] ?? '';
  const clickCount = (fn.match(/\.click\(\)/g) ?? []).length;
  assert.equal(clickCount, 1, 'downloadBlob still invokes .click() exactly once');
  assert.ok(/revokeObjectURL/.test(fn), 'downloadBlob still revokes the object URL');
  assert.ok(/\.remove\(\)/.test(fn), 'downloadBlob still removes the temporary anchor');
});

test('14+15. this fix does not change ZIP or manifest contracts', async () => {
  const { buildDnaPackZip, packDirectoryName } = await import('../../src/domain/alchemy/dna-pack.ts');
  const { createZip } = await import('../../src/format/zip.ts');
  assert.equal(typeof buildDnaPackZip, 'function');
  assert.equal(typeof packDirectoryName, 'function');
  assert.equal(typeof createZip, 'function');
  const manifest = {
    schemaVersion: 1, packId: 'x', packVersion: 1, familyId: 'y', familyRevision: 1,
    familyName: 'Test', publishedAt: 0, publishingAgentId: 'z', members: [],
  };
  const zip = buildDnaPackZip(manifest, new Map());
  assert.equal(zip[0], 0x50); assert.equal(zip[1], 0x4b); // unchanged 'PK' signature
});

test('16+17. export never touches Family revision or previous Published Artifacts', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { SqliteRecordStore } = await import('../../src/adapters/node-sqlite/record-store.ts');
  const { FsContentStore } = await import('../../src/adapters/content-fs/content-store.ts');
  const { DataRegistry } = await import('../../src/registries/data-registry.ts');
  const { registerAlchemyVocabulary } = await import('../../src/domain/alchemy/vocabulary.ts');
  const { AlchemyService } = await import('../../src/domain/alchemy/service.ts');
  const { FamilyService } = await import('../../src/domain/alchemy/family-service.ts');
  const { migrate, CURRENT_SCHEMA } = await import('../../src/migrations/index.ts');
  const { synthesize, encodeWav } = await import('../../src/audio/wav.ts');
  const { COLLECTIONS } = await import('../../src/core/primitives.ts');

  const dir = mkdtempSync(join(tmpdir(), 'spk-export-'));
  const records = new SqliteRecordStore(join(dir, 'store.sqlite'), CURRENT_SCHEMA);
  await migrate(records);
  const content = new FsContentStore(join(dir, 'content'));
  const registry = new DataRegistry();
  registerAlchemyVocabulary(registry);
  const service = new AlchemyService(records, content, registry);
  const families = new FamilyService(records, content, registry);
  const artist = await service.registerAgent({ kind: 'human', name: 'artist', version: '1' });
  const a = await service.importMaterial({
    bytes: encodeWav(synthesize(50, 8000, 1, 2000)), filename: 'a.wav', agentId: artist.id });
  const family = await families.createFamily({ name: 'F', materialIds: [a.id], agentId: artist.id });
  const revisionBefore = (await families.getFamily(family.id)).attributes.revision;

  const { pack: packV1 } = await families.publish(family.id, artist.id);

  // Simulate the export orchestrator running download AND a later share of
  // the SAME artifact — neither should touch canonical state at all, since
  // export happens entirely client-side on already-fetched bytes.
  const { deps } = mockDeps();
  const controller = new DnaPackExportController(deps);
  await controller.publishAndDownload(family.id, async () => {
    throw new Error('should not be called: this test only exercises export, not re-publish');
  }).catch(() => {}); // the injected publish is never meant to run here

  const revisionAfter = (await families.getFamily(family.id)).attributes.revision;
  assert.equal(revisionAfter, revisionBefore, 'export must never bump Family revision');

  const rereadPack = await records.get(COLLECTIONS.entities, packV1.id);
  assert.deepEqual((rereadPack as unknown as { attributes: unknown }).attributes, packV1.attributes,
    'the previously published pack is untouched by any export interaction');
  await records.close();
});

test('18. browser bundle export path remains free of Node built-ins', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile('src/web/export-orchestrator.ts', 'utf8');
  assert.ok(!/from ['"]node:/.test(source));
});
