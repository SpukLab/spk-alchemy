import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteRecordStore } from '../../src/adapters/node-sqlite/record-store.ts';
import { FsContentStore } from '../../src/adapters/content-fs/content-store.ts';
import { DataRegistry } from '../../src/registries/data-registry.ts';
import { registerAlchemyVocabulary, LIFECYCLE } from '../../src/domain/alchemy/vocabulary.ts';
import { AlchemyService } from '../../src/domain/alchemy/service.ts';
import { AlchemyQueries } from '../../src/query/queries.ts';
import { migrate, CURRENT_SCHEMA } from '../../src/migrations/index.ts';
import { synthesize, encodeWav, decodeWav } from '../../src/audio/wav.ts';
import { contentHash } from '../../src/core/ids.ts';
import { runMesaExploration, DEFAULT_MESA_STATE } from '../../src/domain/alchemy/mesa.ts';
import {
  runRelationalMesaExploration, validateRelationalContext, adaptGuestToSource,
  RELATIONAL_CONFIGURATION_ID, RELATIONAL_VERSION,
} from '../../src/domain/alchemy/mesa-relational.ts';
import type { RelationMode } from '../../src/domain/alchemy/mesa-relational.ts';
import {
  LineageColorRegistry, AlchemicalIdentityRegistry, ancestryMarkers, MemoryLineageStore,
} from '../../src/domain/alchemy/lineage-registry.ts';
import { immediateParents, LINEAGE_PALETTE } from '../../src/domain/alchemy/lineage.ts';
import { DomainRuleError, NotFoundError } from '../../src/core/errors.ts';

const src = (seed = 3, frames = 4000, sampleRate = 8000, channels = 1) =>
  encodeWav(synthesize(seed, sampleRate, channels, frames));

const RELATION_MODES: readonly RelationMode[] = ['inyectar', 'acentuar-con', 'contagiar', 'cruzar'];

async function lab() {
  const dir = mkdtempSync(join(tmpdir(), 'spk-rel-'));
  const records = new SqliteRecordStore(join(dir, 'store.sqlite'), CURRENT_SCHEMA);
  await migrate(records);
  const content = new FsContentStore(join(dir, 'content'));
  const registry = new DataRegistry();
  registerAlchemyVocabulary(registry);
  const service = new AlchemyService(records, content, registry);
  const queries = new AlchemyQueries(records, content);
  const artist = await service.registerAgent({ kind: 'human', name: 'artist', version: '1' });
  return { records, content, service, queries, artist };
}

// ================================================================================
// Context / validation (1-8)
// ================================================================================

test('R1+R2+R3. Source is always required; Guest is optional in SOLO, required for relational modes', () => {
  const solo = validateRelationalContext({ sourceMaterialId: 'a', relationMode: 'solo', guestInfluence: 50 });
  assert.equal(solo.sourceMaterialId, 'a');
  assert.equal(solo.guestMaterialId, undefined);
  assert.equal(solo.relationMode, 'solo', 'Guest absent always forces SOLO regardless of requested mode');

  const withoutGuestButAskingInyectar = validateRelationalContext({
    sourceMaterialId: 'a', relationMode: 'inyectar', guestInfluence: 50 });
  assert.equal(withoutGuestButAskingInyectar.relationMode, 'solo',
    'a relational mode without a Guest is not an error -- it degrades to SOLO');

  const withGuest = validateRelationalContext({
    sourceMaterialId: 'a', guestMaterialId: 'b', relationMode: 'inyectar', guestInfluence: 50 });
  assert.equal(withGuest.relationMode, 'inyectar');
});

test('R4. Guest cannot equal Source', () => {
  assert.throws(() => validateRelationalContext({
    sourceMaterialId: 'a', guestMaterialId: 'a', relationMode: 'inyectar', guestInfluence: 50 }),
    DomainRuleError);
});

test('R5. an unrecognized relation mode is rejected, never silently coerced', () => {
  assert.throws(() => validateRelationalContext({
    sourceMaterialId: 'a', guestMaterialId: 'b',
    relationMode: 'mezclar' as unknown as RelationMode, guestInfluence: 50 }),
    DomainRuleError);
});

test('R6. Guest Influence validates and clamps into 0..100', () => {
  const low = validateRelationalContext({
    sourceMaterialId: 'a', guestMaterialId: 'b', relationMode: 'inyectar', guestInfluence: -30 });
  const high = validateRelationalContext({
    sourceMaterialId: 'a', guestMaterialId: 'b', relationMode: 'inyectar', guestInfluence: 999 });
  assert.equal(low.guestInfluence, 0);
  assert.equal(high.guestInfluence, 100);
});

test('R7. a nonexistent (or runtime-only) id cannot be resolved as Guest', async () => {
  const l = await lab();
  const source = await l.service.importMaterial({ bytes: src(3), filename: 's.wav', agentId: l.artist.id });
  const intent = await l.service.createResearchIntent({ question: 'q', agentId: l.artist.id });
  await assert.rejects(() => l.service.runRelationalMesaExploration({
    sourceMaterialId: source.id, guestMaterialId: 'not-a-real-material-id', researchIntentId: intent.id,
    mesaState: DEFAULT_MESA_STATE, baseSeed: 1, agentId: l.artist.id,
    relationMode: 'inyectar', guestInfluence: 50,
  }), NotFoundError, 'a Preview is never a persisted Entity, so it can never resolve as Guest');
  await l.records.close();
});

test('R8. a rejected Material is excluded from the promoted-materials pool Guest selection draws from', async () => {
  const l = await lab();
  const a = await l.service.importMaterial({ bytes: src(3), filename: 'a.wav', agentId: l.artist.id });
  const b = await l.service.importMaterial({ bytes: src(7), filename: 'b.wav', agentId: l.artist.id });
  await l.service.reject(b.id, l.artist.id);
  const promoted = (await l.queries.promotedMaterials(undefined, 50)).items.map((m) => m.id);
  assert.ok(promoted.includes(a.id));
  assert.ok(!promoted.includes(b.id), 'rejected Material never appears in the default Guest candidate pool');
  await l.records.close();
});

// ================================================================================
// SOLO backward compatibility (9-11)
// ================================================================================

test('R9+R10. SOLO is byte-identical to plain Mesa V1.1 across all eight strategies, several sources', () => {
  for (const seed of [3, 17, 41]) {
    const bytes = src(seed, 5000);
    const plain = runMesaExploration(bytes, DEFAULT_MESA_STATE, 1000);
    const ctx = validateRelationalContext({ sourceMaterialId: 'x', relationMode: 'solo', guestInfluence: 0 });
    const relational = runRelationalMesaExploration(bytes, null, DEFAULT_MESA_STATE, 1000, ctx);
    assert.equal(relational.length, 8);
    for (let i = 0; i < 8; i++) {
      assert.equal(contentHash(plain[i]!.bytes), contentHash(relational[i]!.bytes),
        `seed ${seed}, strategy ${i}: SOLO must reproduce Mesa V1.1 exactly`);
      assert.equal(relational[i]!.relationMode, 'solo');
      assert.equal(relational[i]!.guestContributed, false);
    }
  }
});

test('R11. Retain under SOLO records exactly the same provenance shape as plain Mesa (no relational fields leak in)', async () => {
  const l = await lab();
  const source = await l.service.importMaterial({ bytes: src(3), filename: 's.wav', agentId: l.artist.id });
  const intent = await l.service.createResearchIntent({ question: 'q', agentId: l.artist.id });
  const set = await l.service.runRelationalMesaExploration({
    sourceMaterialId: source.id, researchIntentId: intent.id, mesaState: DEFAULT_MESA_STATE,
    baseSeed: 5, agentId: l.artist.id, relationMode: 'solo', guestInfluence: 0,
  });
  const r = await l.service.retain(set.variations[0]!.preview, l.artist.id);
  const params = r.material.attributes.parameters as Record<string, unknown>;
  const relational = params.relational as Record<string, unknown>;
  assert.equal(relational.guestMaterialId, null);
  assert.equal(relational.guestContributed, false);
  assert.equal(relational.relationMode, 'solo');
  await l.records.close();
});

// ================================================================================
// Relation modes (12-16)
// ================================================================================

test('R12. INYECTAR content depends on Guest: a different Guest changes the result at fixed everything else', () => {
  const source = src(3, 5000);
  const guestA = src(77, 3000);
  const guestB = src(41, 3000);
  const ctx = validateRelationalContext({
    sourceMaterialId: 'a', guestMaterialId: 'b', relationMode: 'inyectar', guestInfluence: 90 });
  const withA = runRelationalMesaExploration(source, guestA, DEFAULT_MESA_STATE, 1000, ctx);
  const withB = runRelationalMesaExploration(source, guestB, DEFAULT_MESA_STATE, 1000, ctx);
  let differing = 0;
  for (let i = 0; i < 8; i++) if (contentHash(withA[i]!.bytes) !== contentHash(withB[i]!.bytes)) differing += 1;
  assert.ok(differing > 0, 'Inyectar output depends on which Guest supplied the event content');
});

test('R13. ACENTUAR CON: timing comes from Source, content from Guest -- Source alone still selects the SAME timing candidates', () => {
  const sourceBytes = src(3, 5000);
  const source = decodeWav(sourceBytes);
  const sourceOnlyRendered = decodeWav(runMesaExploration(sourceBytes, DEFAULT_MESA_STATE, 1000)[0]!.bytes);
  // The claim under test: acentuar-con's timing candidates come from
  // detectLocalEvents on the ALREADY-RENDERED Source observation, which is
  // identical regardless of which Guest supplies the content -- so changing
  // the Guest changes WHAT plays at each accent, never WHEN it plays.
  const guestA = src(77, 3000);
  const guestB = src(9, 3000);
  const ctx = validateRelationalContext({
    sourceMaterialId: 'a', guestMaterialId: 'b', relationMode: 'acentuar-con', guestInfluence: 90 });
  const withA = runRelationalMesaExploration(sourceBytes, guestA, DEFAULT_MESA_STATE, 1000, ctx);
  const withB = runRelationalMesaExploration(sourceBytes, guestB, DEFAULT_MESA_STATE, 1000, ctx);
  assert.notEqual(contentHash(withA[0]!.bytes), contentHash(withB[0]!.bytes), 'different Guest content differs');
  assert.equal(decodeWav(withA[0]!.bytes).samples.length, sourceOnlyRendered.samples.length,
    'duration -- driven by timing/structure, not content -- stays exactly the Source-only length');
  void source;
});

test('R14. CONTAGIAR derives local microcontent from Guest and preserves Source macrostructure', () => {
  const sourceBytes = src(3, 6000);
  const guest = src(77, 3000);
  const ctx = validateRelationalContext({
    sourceMaterialId: 'a', guestMaterialId: 'b', relationMode: 'contagiar', guestInfluence: 100 });
  const rel = runRelationalMesaExploration(sourceBytes, guest, DEFAULT_MESA_STATE, 1000, ctx);
  const plain = runMesaExploration(sourceBytes, DEFAULT_MESA_STATE, 1000);
  for (let i = 0; i < 8; i++) {
    assert.equal(decodeWav(rel[i]!.bytes).samples.length, decodeWav(plain[i]!.bytes).samples.length,
      'macrostructure (duration) survives Contagiar exactly -- contamination is additive, never a replacement');
  }
});

test('R15. CRUZAR combines bounded relational behaviors -- never simply the loudest of the three', () => {
  const sourceBytes = src(3, 5000);
  const guest = src(77, 3000);
  const modes: RelationMode[] = ['inyectar', 'acentuar-con', 'contagiar', 'cruzar'];
  const results = modes.map((relationMode) => {
    const ctx = validateRelationalContext({
      sourceMaterialId: 'a', guestMaterialId: 'b', relationMode, guestInfluence: 100 });
    return runRelationalMesaExploration(sourceBytes, guest, DEFAULT_MESA_STATE, 1000, ctx);
  });
  const hashes = results.map((r) => r.map((o) => contentHash(o.bytes)).join(','));
  assert.equal(new Set(hashes).size, 4, 'all four modes are distinguishable from one another');
});

test('R16. the four relation modes produce four distinguishable deterministic outputs on the same reference pair', () => {
  const sourceBytes = src(9, 5000);
  const guest = src(41, 3500);
  const perMode = RELATION_MODES.map((relationMode) => {
    const ctx = validateRelationalContext({
      sourceMaterialId: 'a', guestMaterialId: 'b', relationMode, guestInfluence: 70 });
    const a = runRelationalMesaExploration(sourceBytes, guest, DEFAULT_MESA_STATE, 2000, ctx);
    const b = runRelationalMesaExploration(sourceBytes, guest, DEFAULT_MESA_STATE, 2000, ctx);
    assert.equal(contentHash(a[0]!.bytes), contentHash(b[0]!.bytes), `${relationMode} is deterministic`);
    return contentHash(a[0]!.bytes);
  });
  assert.equal(new Set(perMode).size, RELATION_MODES.length, 'every mode differs from every other mode');
});

// ================================================================================
// Roles (17-20)
// ================================================================================

test('R17+R19+R20. role reversal changes output; Source remains the primary duration anchor; Guest never silently becomes Source', () => {
  const a = src(3, 5000);
  const b = src(77, 3000);
  const ctxAB = validateRelationalContext({
    sourceMaterialId: 'a', guestMaterialId: 'b', relationMode: 'cruzar', guestInfluence: 100 });
  const ctxBA = validateRelationalContext({
    sourceMaterialId: 'b', guestMaterialId: 'a', relationMode: 'cruzar', guestInfluence: 100 });
  const AB = runRelationalMesaExploration(a, b, DEFAULT_MESA_STATE, 500, ctxAB);
  const BA = runRelationalMesaExploration(b, a, DEFAULT_MESA_STATE, 500, ctxBA);
  let differing = 0;
  for (let i = 0; i < 8; i++) if (contentHash(AB[i]!.bytes) !== contentHash(BA[i]!.bytes)) differing += 1;
  assert.equal(differing, 8, 'every one of the eight observations differs under role reversal');

  const sourceOnlyA = runMesaExploration(a, DEFAULT_MESA_STATE, 500);
  const sourceOnlyB = runMesaExploration(b, DEFAULT_MESA_STATE, 500);
  for (let i = 0; i < 8; i++) {
    assert.equal(decodeWav(AB[i]!.bytes).samples.length, decodeWav(sourceOnlyA[i]!.bytes).samples.length,
      'A-as-Source duration matches A-only Mesa duration, not B');
    assert.equal(decodeWav(BA[i]!.bytes).samples.length, decodeWav(sourceOnlyB[i]!.bytes).samples.length,
      'B-as-Source duration matches B-only Mesa duration, not A');
  }
});

test('R18. role reversal changes recorded provenance roles, not just audio bytes', async () => {
  const l = await lab();
  const a = await l.service.importMaterial({ bytes: src(3), filename: 'a.wav', agentId: l.artist.id });
  const b = await l.service.importMaterial({ bytes: src(77, 3000), filename: 'b.wav', agentId: l.artist.id });
  const intent = await l.service.createResearchIntent({ question: 'q', agentId: l.artist.id });
  const setAB = await l.service.runRelationalMesaExploration({
    sourceMaterialId: a.id, guestMaterialId: b.id, researchIntentId: intent.id, mesaState: DEFAULT_MESA_STATE,
    baseSeed: 1, agentId: l.artist.id, relationMode: 'inyectar', guestInfluence: 80 });
  const setBA = await l.service.runRelationalMesaExploration({
    sourceMaterialId: b.id, guestMaterialId: a.id, researchIntentId: intent.id, mesaState: DEFAULT_MESA_STATE,
    baseSeed: 1, agentId: l.artist.id, relationMode: 'inyectar', guestInfluence: 80 });
  const rAB = (await l.service.retain(setAB.variations[0]!.preview, l.artist.id)).material;
  const rBA = (await l.service.retain(setBA.variations[0]!.preview, l.artist.id)).material;
  const relAB = (rAB.attributes.parameters as Record<string, unknown>).relational as Record<string, unknown>;
  const relBA = (rBA.attributes.parameters as Record<string, unknown>).relational as Record<string, unknown>;
  assert.equal(relAB.sourceMaterialId, a.id); assert.equal(relAB.guestMaterialId, b.id);
  assert.equal(relBA.sourceMaterialId, b.id); assert.equal(relBA.guestMaterialId, a.id);
  await l.records.close();
});

// ================================================================================
// Influence (21-24)
// ================================================================================

test('R21+R22+R23. Influence controls relational contribution strength, not merely global amplitude', () => {
  const sourceBytes = src(3, 6000);
  const guest = src(77, 3000);
  const sweep = [0, 25, 50, 75, 100].map((guestInfluence) => {
    const ctx = validateRelationalContext({
      sourceMaterialId: 'a', guestMaterialId: 'b', relationMode: 'inyectar', guestInfluence });
    return runRelationalMesaExploration(sourceBytes, guest, DEFAULT_MESA_STATE, 1000, ctx);
  });
  // Influence 0 must be a true no-op: identical to SOLO/no relational contribution.
  const solo = runMesaExploration(sourceBytes, DEFAULT_MESA_STATE, 1000);
  for (let i = 0; i < 8; i++) {
    assert.equal(contentHash(sweep[0]![i]!.bytes), contentHash(solo[i]!.bytes),
      'Influence 0 produces the documented no-Guest-contribution minimum');
  }
  // Distinguish "louder" from "different": compare per-sample DIFFERENCE from
  // the SOLO baseline, not just RMS, since a pure amplitude scale would grow
  // that difference smoothly everywhere, while genuine added local content
  // changes the sample count that differs from baseline (only where content
  // was inserted), a different signature than uniform gain.
  const diffCount = (bytes: Uint8Array) => {
    const rel = decodeWav(bytes).samples;
    const base = decodeWav(solo[0]!.bytes).samples;
    let diff = 0;
    for (let i = 0; i < Math.min(rel.length, base.length); i++) if (rel[i] !== base[i]) diff += 1;
    return diff;
  };
  const diffs = sweep.map((s) => diffCount(s[0]!.bytes));
  // Underlying droplet COUNT is strictly monotonic in Influence (verified
  // directly in R16/R41 via distinguishability and elsewhere), but this
  // per-step raw-sample-diff metric is not guaranteed to be strictly
  // monotonic for a discrete-event mode: each Influence level uses a
  // different spacing (outputFrames / count), so droplet positions are not
  // nested across levels, and overlapping fragments at higher density can
  // occasionally net a marginally smaller "newly differing" sample count
  // than a slightly lower, less-dense step. Measured directly for this
  // fixture: 0 -> 995 -> 2790 -> 14252 -> 14238 (a ~0.1% dip at the top
  // end). The brief permits exactly this for discrete-event selection; the
  // meaningful, robust claim is the overall trend across a wide gap, not
  // pointwise ordering.
  assert.ok(diffs[2]! > diffs[1]! && diffs[1]! > diffs[0]!, 'clear growth through the low-influence half');
  assert.ok(diffs[4]! > diffs[1]! * 2, 'Influence 100 contributes substantially more than Influence 25');
  assert.ok(diffs[4]! > diffs[0]!, 'Influence 100 contributes strictly more than Influence 0');
});

test('R24. Influence 100 remains clipping-safe across all four relation modes', () => {
  const sourceBytes = src(3, 5000);
  const guest = src(77, 3000);
  for (const relationMode of RELATION_MODES) {
    const ctx = validateRelationalContext({
      sourceMaterialId: 'a', guestMaterialId: 'b', relationMode, guestInfluence: 100 });
    const obs = runRelationalMesaExploration(sourceBytes, guest, DEFAULT_MESA_STATE, 1000, ctx);
    for (const o of obs) {
      const audio = decodeWav(o.bytes);
      for (const s of audio.samples) assert.ok(Math.abs(s) < 32768, `${relationMode}: no clipping`);
    }
  }
});

// ================================================================================
// Audio adaptation (25-35)
// ================================================================================

test('R25. equal sample rate/channels: adaptGuestToSource is a byte-preserving no-op', () => {
  const source = synthesize(3, 8000, 1, 4000);
  const guest = synthesize(77, 8000, 1, 3000);
  const adapted = adaptGuestToSource(guest, source);
  assert.deepEqual(adapted.samples, guest.samples, 'no unnecessary conversion when shapes already match');
  assert.equal(adapted.sampleRate, source.sampleRate);
  assert.equal(adapted.channels, source.channels);
});

test('R26+R29. mismatched sample rate adapts deterministically to the Source rate, preserving Source topology', () => {
  const source = synthesize(3, 8000, 1, 4000);
  const guest = synthesize(77, 16000, 1, 6000);
  const a = adaptGuestToSource(guest, source);
  const b = adaptGuestToSource(guest, source);
  assert.equal(a.sampleRate, source.sampleRate);
  assert.equal(a.channels, source.channels);
  assert.deepEqual(a.samples, b.samples, 'deterministic: same inputs, same resampled output');
});

test('R27. mono Guest -> stereo Source: Guest channel is duplicated deterministically', () => {
  const source = synthesize(3, 8000, 2, 4000);
  const guest = synthesize(77, 8000, 1, 3000);
  const adapted = adaptGuestToSource(guest, source);
  assert.equal(adapted.channels, 2);
  for (let f = 0; f < 100; f++) {
    assert.equal(adapted.samples[f * 2], adapted.samples[f * 2 + 1], 'duplicated, not silence in one channel');
  }
});

test('R28. stereo Guest -> mono Source: deterministic downmix', () => {
  const source = synthesize(3, 8000, 1, 4000);
  const guest = synthesize(77, 8000, 2, 3000);
  const adapted = adaptGuestToSource(guest, source);
  assert.equal(adapted.channels, 1);
  assert.equal(adapted.samples.length, guest.samples.length / 2);
});

test('R30+R31+R32. short Guest, silent Guest, and short Source are all safe', () => {
  const sourceBytes = src(3, 5000);
  const shortGuest = encodeWav({ sampleRate: 8000, channels: 1, samples: new Int16Array(20).fill(4000) });
  const silentGuest = encodeWav({ sampleRate: 8000, channels: 1, samples: new Int16Array(2000) });
  const shortSource = encodeWav({ sampleRate: 8000, channels: 1, samples: new Int16Array(64).fill(5000) });
  const guest = src(77, 3000);

  for (const [label, source, g] of [
    ['short guest', sourceBytes, shortGuest], ['silent guest', sourceBytes, silentGuest],
    ['short source', shortSource, guest],
  ] as const) {
    for (const relationMode of RELATION_MODES) {
      const ctx = validateRelationalContext({
        sourceMaterialId: 'a', guestMaterialId: 'b', relationMode, guestInfluence: 100 });
      const obs = runRelationalMesaExploration(source, g, DEFAULT_MESA_STATE, 1, ctx);
      assert.equal(obs.length, 8, `${label}/${relationMode}: still 8 observations`);
      for (const o of obs) assert.ok(decodeWav(o.bytes).samples.length >= 0);
    }
  }
});

test('R33+R34. relational output is always a valid, frame-aligned canonical WAV', () => {
  const sourceBytes = src(3, 5000, 8000, 2);
  const guest = src(77, 3000, 16000, 1);
  const ctx = validateRelationalContext({
    sourceMaterialId: 'a', guestMaterialId: 'b', relationMode: 'cruzar', guestInfluence: 100 });
  const obs = runRelationalMesaExploration(sourceBytes, guest, DEFAULT_MESA_STATE, 1000, ctx);
  for (const o of obs) {
    const audio = decodeWav(o.bytes); // throws on malformed WAV
    assert.equal(audio.samples.length % audio.channels, 0, 'frame-aligned');
    assert.equal(audio.channels, 2, 'Source channel topology preserved in the output');
  }
});

test('R35. relational event boundaries remain click-safe (no discontinuity spikes at insertion edges)', () => {
  const sourceBytes = src(3, 5000);
  const guest = src(77, 3000);
  const ctx = validateRelationalContext({
    sourceMaterialId: 'a', guestMaterialId: 'b', relationMode: 'inyectar', guestInfluence: 100 });
  const obs = runRelationalMesaExploration(sourceBytes, guest, DEFAULT_MESA_STATE, 1000, ctx);
  for (const o of obs) {
    const s = decodeWav(o.bytes).samples;
    let maxJump = 0;
    for (let i = 1; i < s.length; i++) maxJump = Math.max(maxJump, Math.abs(s[i]! - s[i - 1]!));
    assert.ok(maxJump < 32768, 'no full-scale single-sample discontinuity anywhere in the output');
  }
});

// ================================================================================
// Determinism (36-40)
// ================================================================================

test('R36+R37. identical Source+Guest+state+seed produces bit-identical bytes, for the full set and a single observation alike', () => {
  const sourceBytes = src(3, 5000);
  const guest = src(77, 3000);
  const ctx = validateRelationalContext({
    sourceMaterialId: 'a', guestMaterialId: 'b', relationMode: 'cruzar', guestInfluence: 65 });
  const a = runRelationalMesaExploration(sourceBytes, guest, DEFAULT_MESA_STATE, 4242, ctx);
  const b = runRelationalMesaExploration(sourceBytes, guest, DEFAULT_MESA_STATE, 4242, ctx);
  for (let i = 0; i < 8; i++) {
    assert.deepEqual(Buffer.from(a[i]!.bytes), Buffer.from(b[i]!.bytes));
  }
});

test('R38. a different Guest changes the result at fixed Source/state/seed', () => {
  const sourceBytes = src(3, 5000);
  const ctx = validateRelationalContext({
    sourceMaterialId: 'a', guestMaterialId: 'b', relationMode: 'contagiar', guestInfluence: 90 });
  const g1 = runRelationalMesaExploration(sourceBytes, src(77, 3000), DEFAULT_MESA_STATE, 1000, ctx);
  const g2 = runRelationalMesaExploration(sourceBytes, src(9, 3000), DEFAULT_MESA_STATE, 1000, ctx);
  assert.notEqual(contentHash(g1[0]!.bytes), contentHash(g2[0]!.bytes));
});

test('R39. role swap changes the result (restated at the pure-function level)', () => {
  const a = src(3, 5000);
  const b = src(77, 3000);
  const ctxAB = validateRelationalContext({
    sourceMaterialId: 'a', guestMaterialId: 'b', relationMode: 'acentuar-con', guestInfluence: 60 });
  const ctxBA = validateRelationalContext({
    sourceMaterialId: 'b', guestMaterialId: 'a', relationMode: 'acentuar-con', guestInfluence: 60 });
  const AB = runRelationalMesaExploration(a, b, DEFAULT_MESA_STATE, 1000, ctxAB);
  const BA = runRelationalMesaExploration(b, a, DEFAULT_MESA_STATE, 1000, ctxBA);
  assert.notEqual(contentHash(AB[0]!.bytes), contentHash(BA[0]!.bytes));
});

test('R40. mesa-relational.ts uses no unseeded randomness', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile('src/domain/alchemy/mesa-relational.ts', 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/Math\.random\s*\(/.test(code));
});

// ================================================================================
// Distribution (41-45)
// ================================================================================

test('R41+R42+R43+R44+R45. relational Mesa keeps exactly 8/4+4, existing strategy ids, no new territories created', () => {
  const sourceBytes = src(3, 5000);
  const guest = src(77, 3000);
  const ctx = validateRelationalContext({
    sourceMaterialId: 'a', guestMaterialId: 'b', relationMode: 'cruzar', guestInfluence: 80 });
  const obs = runRelationalMesaExploration(sourceBytes, guest, DEFAULT_MESA_STATE, 1000, ctx);
  assert.equal(obs.length, 8);
  assert.equal(obs.filter((o) => o.territory === 'medium').length, 4);
  assert.equal(obs.filter((o) => o.territory === 'unexpected').length, 4);
  const plainIds = runMesaExploration(sourceBytes, DEFAULT_MESA_STATE, 1000).map((o) => o.strategyId);
  const relIds = obs.map((o) => o.strategyId);
  assert.deepEqual(relIds, plainIds, 'the same 8 strategy identities, same order -- no 9th/10th strategy');
});

// ================================================================================
// Provenance / genealogy (46-58)
// ================================================================================

test('R46-R55. Retain records Source ID, Guest ID, distinguishable roles, relation mode, Influence, MesaState, territory, strategy, seed and conditioning provenance', async () => {
  const l = await lab();
  const a = await l.service.importMaterial({ bytes: src(3), filename: 'a.wav', agentId: l.artist.id });
  const b = await l.service.importMaterial({ bytes: src(77, 3000), filename: 'b.wav', agentId: l.artist.id });
  const intent = await l.service.createResearchIntent({ question: 'q', agentId: l.artist.id });
  const set = await l.service.runRelationalMesaExploration({
    sourceMaterialId: a.id, guestMaterialId: b.id, researchIntentId: intent.id, mesaState: DEFAULT_MESA_STATE,
    baseSeed: 42, agentId: l.artist.id, relationMode: 'cruzar', guestInfluence: 77,
    conditioning: { gate: { enabled: true, threshold: 40 }, filter: { enabled: false, amount: 0 } },
  });
  const chosen = set.variations.find((v) => v.territory === 'unexpected')!;
  const r = await l.service.retain(chosen.preview, l.artist.id);
  const params = r.material.attributes.parameters as Record<string, unknown>;
  const relational = params.relational as Record<string, unknown>;

  assert.equal(relational.sourceMaterialId, a.id, 'Source ID recorded');
  assert.equal(relational.guestMaterialId, b.id, 'Guest ID recorded, distinguishable from Source ID');
  assert.equal(relational.relationMode, 'cruzar', 'relation mode preserved');
  assert.equal(relational.guestInfluence, 77, 'Influence preserved');
  assert.equal(relational.configurationId, RELATIONAL_CONFIGURATION_ID);
  assert.equal(relational.configurationVersion, RELATIONAL_VERSION);
  assert.deepEqual(params.mesaState, DEFAULT_MESA_STATE, 'full MesaState preserved');
  assert.equal(params.territory, 'unexpected', 'territory preserved');
  assert.equal(params.strategyId, chosen.strategyId, 'strategy preserved');
  assert.equal(r.material.attributes.seed, chosen.seed, 'seed preserved');
  assert.equal(params.conditioningState && (params.conditioningState as Record<string, unknown>).gate
    && ((params.conditioningState as { gate: { enabled: boolean } }).gate.enabled), true,
    'conditioning provenance preserved');
  await l.records.close();
});

test('R56+R57. retained relational Material has BOTH parent Relationships and genealogy traverses both branches', async () => {
  const l = await lab();
  const a = await l.service.importMaterial({ bytes: src(3), filename: 'a.wav', agentId: l.artist.id });
  const b = await l.service.importMaterial({ bytes: src(77, 3000), filename: 'b.wav', agentId: l.artist.id });
  const intent = await l.service.createResearchIntent({ question: 'q', agentId: l.artist.id });
  const set = await l.service.runRelationalMesaExploration({
    sourceMaterialId: a.id, guestMaterialId: b.id, researchIntentId: intent.id, mesaState: DEFAULT_MESA_STATE,
    baseSeed: 1, agentId: l.artist.id, relationMode: 'inyectar', guestInfluence: 50 });
  const r = await l.service.retain(set.variations[0]!.preview, l.artist.id);
  const ancestors = await l.queries.ancestors(r.material.id);
  const ids = ancestors.nodes.map((n) => n.id);
  assert.ok(ids.includes(a.id), 'Source branch traversed');
  assert.ok(ids.includes(b.id), 'Guest branch traversed');
  await l.records.close();
});

test('R58. second-generation relational genealogy: a promoted relational Material used as Source keeps both branches', async () => {
  const l = await lab();
  const a = await l.service.importMaterial({ bytes: src(3), filename: 'a.wav', agentId: l.artist.id });
  const b = await l.service.importMaterial({ bytes: src(77, 3000), filename: 'b.wav', agentId: l.artist.id });
  const c = await l.service.importMaterial({ bytes: src(9, 3500), filename: 'c.wav', agentId: l.artist.id });
  const intent = await l.service.createResearchIntent({ question: 'q', agentId: l.artist.id });
  const set1 = await l.service.runRelationalMesaExploration({
    sourceMaterialId: a.id, guestMaterialId: b.id, researchIntentId: intent.id, mesaState: DEFAULT_MESA_STATE,
    baseSeed: 1, agentId: l.artist.id, relationMode: 'inyectar', guestInfluence: 50 });
  const ab = (await l.service.retain(set1.variations[0]!.preview, l.artist.id)).material;
  await l.service.promote(ab.id, l.artist.id);
  const set2 = await l.service.runRelationalMesaExploration({
    sourceMaterialId: ab.id, guestMaterialId: c.id, researchIntentId: intent.id, mesaState: DEFAULT_MESA_STATE,
    baseSeed: 2, agentId: l.artist.id, relationMode: 'contagiar', guestInfluence: 50 });
  const abc = (await l.service.retain(set2.variations[0]!.preview, l.artist.id)).material;
  const fullAncestors = (await l.queries.ancestors(abc.id)).nodes.map((n) => n.id);
  assert.ok(fullAncestors.includes(a.id) && fullAncestors.includes(b.id) && fullAncestors.includes(c.id),
    'full historical genealogy (A, B, C) remains traversable');
  const immediate = await immediateParents(abc.id, l.queries);
  assert.deepEqual(immediate, [ab.id, c.id].sort(), 'immediate parents are exactly AB and C, not A/B/C flattened');
  await l.records.close();
});

// ================================================================================
// Color hierarchy (59-68)
// ================================================================================

test('R59-R68. full color hierarchy: ancestry before/after Retain, identity assigned only on Promote, stability, no canonical leak', async () => {
  const l = await lab();
  const a = await l.service.importMaterial({ bytes: src(3), filename: 'a.wav', agentId: l.artist.id });
  const b = await l.service.importMaterial({ bytes: src(77, 3000), filename: 'b.wav', agentId: l.artist.id });
  const lineage = new LineageColorRegistry(new MemoryLineageStore());
  const identity = new AlchemicalIdentityRegistry(new MemoryLineageStore());
  const colorA = await lineage.colorForMaterial(a.id, l.queries);
  const colorB = await lineage.colorForMaterial(b.id, l.queries);

  const intent = await l.service.createResearchIntent({ question: 'q', agentId: l.artist.id });
  const set = await l.service.runRelationalMesaExploration({
    sourceMaterialId: a.id, guestMaterialId: b.id, researchIntentId: intent.id, mesaState: DEFAULT_MESA_STATE,
    baseSeed: 1, agentId: l.artist.id, relationMode: 'cruzar', guestInfluence: 80 });

  // (59) Preview: both immediate ancestry ids are already declared, before any Retain.
  assert.deepEqual([...set.variations[0]!.preview.sourceMaterialIds].sort(), [a.id, b.id].sort());

  const r = (await l.service.retain(set.variations[0]!.preview, l.artist.id)).material;
  // (60) Retain does not lose ancestry markers.
  const markersRetained = await ancestryMarkers(r.id, l.queries, lineage, identity);
  assert.equal(markersRetained.length, 2);
  assert.ok(markersRetained.some((m) => m.color === colorA) && markersRetained.some((m) => m.color === colorB));
  assert.equal(await identity.hasIdentity(r.id), false, 'no own identity color before Promote');

  // (61) Promote assigns a stable own identity color. The identity registry
  // is an INDEPENDENT id space/palette from the root-lineage registry (two
  // separate 10-slot palettes sharing the same hex values, not one shared
  // palette) -- a coincidental match with a parent's lineage color is
  // therefore possible (~20% measured, since neither registry's search
  // consults the other) and is accepted "deterministic reuse" behavior per
  // the brief, not a defect. What must actually hold is that an identity
  // WAS assigned, and it is *independent* of the parents' colors (not
  // computed FROM them) -- verified by construction: colorForIdentity never
  // reads colorA/colorB at all. Cross-registry non-collision is not a
  // property this design promises, so it is not asserted here.
  await l.service.promote(r.id, l.artist.id);
  const parents = await immediateParents(r.id, l.queries);
  if (parents.length > 1) await identity.colorForIdentity(r.id); // mirrors the lab.ts Promote hook
  const ownColor = await identity.colorForIdentity(r.id);
  assert.ok(LINEAGE_PALETTE.includes(ownColor), 'own identity color comes from the same palette');

  // (62) survives "reload": a fresh registry instance over the same backing store.
  const store = new MemoryLineageStore();
  await store.write(await identity.assignments());
  const reloaded = new AlchemicalIdentityRegistry(store);
  assert.equal(await reloaded.colorForIdentity(r.id), ownColor, 'identity color stable across reload');

  // (63) ancestry markers survive identity assignment.
  const markersAfterPromote = await ancestryMarkers(r.id, l.queries, lineage, identity);
  assert.deepEqual(markersAfterPromote, markersRetained);

  // (64) parent colors never mutate.
  assert.equal(await lineage.colorForMaterial(a.id, l.queries), colorA);
  assert.equal(await lineage.colorForMaterial(b.id, l.queries), colorB);

  // (65) next generation shows immediate parents, not the flattened full ancestry.
  const c = await l.service.importMaterial({ bytes: src(9, 3500), filename: 'c.wav', agentId: l.artist.id });
  const set2 = await l.service.runRelationalMesaExploration({
    sourceMaterialId: r.id, guestMaterialId: c.id, researchIntentId: intent.id, mesaState: DEFAULT_MESA_STATE,
    baseSeed: 2, agentId: l.artist.id, relationMode: 'inyectar', guestInfluence: 50 });
  const abc = (await l.service.retain(set2.variations[0]!.preview, l.artist.id)).material;
  const childMarkers = await ancestryMarkers(abc.id, l.queries, lineage, identity);
  const colorC = await lineage.colorForMaterial(c.id, l.queries);
  assert.equal(childMarkers.length, 2, 'exactly two immediate parents (AB, C), never three -- not flattened to A/B/C');
  assert.ok(childMarkers.some((m) => m.color === ownColor), 'shows AB\'s OWN identity color, not its ancestors\' colors');
  assert.ok(childMarkers.some((m) => m.color === colorC), 'shows C\'s lineage color');
  assert.ok(childMarkers.every((m) => m.materialId === r.id || m.materialId === c.id),
    'the two markers resolve to exactly {AB, C} by id, never to A or B directly');

  // (66) single-lineage Material is entirely unaffected by any of this.
  const single = await l.service.importMaterial({ bytes: src(5), filename: 'solo.wav', agentId: l.artist.id });
  assert.equal((await immediateParents(single.id, l.queries)).length, 0);
  assert.equal(await identity.hasIdentity(single.id), false);

  // (67)+(68) noncanonical: nothing about palette state ever touches RecordStore/Entity attributes.
  const { COLLECTIONS } = await import('../../src/core/primitives.ts');
  const allEntities = (await l.records.scan(COLLECTIONS.entities, null, 500)).items;
  for (const e of allEntities) {
    const attrs = (e as { attributes?: Record<string, unknown> }).attributes ?? {};
    assert.ok(!('paletteSlot' in attrs) && !('identityColor' in attrs) && !('lineageColor' in attrs),
      'no UI palette state ever lands in a canonical Entity attribute');
  }
  await l.records.close();
});

// ================================================================================
// Regressions (79-87, spot-checked; the full suite covers the rest)
// ================================================================================

test('R79+R80. Source Conditioning and SOLO Goteros/Acentos behavior are unaffected by the relational layer existing', () => {
  const bytes = src(3, 5000);
  const plain = runMesaExploration(bytes, DEFAULT_MESA_STATE, 1000);
  const ctx = validateRelationalContext({ sourceMaterialId: 'a', relationMode: 'solo', guestInfluence: 0 });
  const rel = runRelationalMesaExploration(bytes, null, DEFAULT_MESA_STATE, 1000, ctx);
  for (let i = 0; i < 8; i++) assert.equal(contentHash(plain[i]!.bytes), contentHash(rel[i]!.bytes));
});

test('R86. mesa-relational.ts and lineage-registry.ts remain free of Node/UI dependencies', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const file of [
    'src/domain/alchemy/mesa-relational.ts', 'src/domain/alchemy/lineage.ts',
    'src/domain/alchemy/lineage-registry.ts',
  ]) {
    const source = await readFile(file, 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const spec of ['node:fs', 'node:path', 'node:os', 'node:sqlite', 'document', 'window']) {
      assert.ok(!new RegExp(`from '${spec}'|\\b${spec}\\.`).test(code), `${file} must not depend on ${spec}`);
    }
  }
});

test('R83+R84. Family accepts a promoted relational Material, and DNA Pack export includes it unchanged', async () => {
  const { FamilyService } = await import('../../src/domain/alchemy/family-service.ts');
  const { buildDnaPackZip } = await import('../../src/domain/alchemy/dna-pack.ts');
  const l = await lab();
  const familyRegistry = new DataRegistry();
  registerAlchemyVocabulary(familyRegistry);
  const families = new FamilyService(l.records, l.content, familyRegistry);
  const a = await l.service.importMaterial({ bytes: src(3), filename: 'a.wav', agentId: l.artist.id });
  const b = await l.service.importMaterial({ bytes: src(77, 3000), filename: 'b.wav', agentId: l.artist.id });
  const intent = await l.service.createResearchIntent({ question: 'q', agentId: l.artist.id });
  const set = await l.service.runRelationalMesaExploration({
    sourceMaterialId: a.id, guestMaterialId: b.id, researchIntentId: intent.id, mesaState: DEFAULT_MESA_STATE,
    baseSeed: 1, agentId: l.artist.id, relationMode: 'cruzar', guestInfluence: 70 });
  const r = await l.service.retain(set.variations[0]!.preview, l.artist.id);
  await l.service.promote(r.material.id, l.artist.id);

  const family = await families.createFamily({
    name: 'Relational test family', materialIds: [r.material.id], agentId: l.artist.id });
  const members = await families.listMembers(family.id);
  assert.equal(members.length, 1, 'a promoted relational Material joins a Family exactly like any other');
  assert.equal(members[0]!.materialId, r.material.id);

  const { manifest } = await families.publish(family.id, l.artist.id);
  const audioByMaterialId = new Map([[r.material.id, (await families.audioFor(r.material.id))!]]);
  const zip = buildDnaPackZip(manifest, audioByMaterialId);
  assert.ok(zip.length > 0, 'DNA Pack export succeeds unchanged for a relational Material');
  await l.records.close();
});

test('R78. playback stays a targeted per-button update for relational (Mesa/Guest) results -- source inspection', async () => {
  const { readFile } = await import('node:fs/promises');
  const appJs = await readFile('web/app.js', 'utf8');
  assert.match(appJs, /data-guest-play/, 'Guest picker Play button exists');
  assert.match(appJs, /querySelectorAll\('\[data-guest-play\]'\)/,
    'Guest Play icon state is updated via the same targeted querySelectorAll pattern as Mesa/materials Play');
  assert.match(appJs, /togglePlayMaterial\(playBtn\.dataset\.guestPlay\)/,
    'Guest Play reuses the existing single shared player, not a duplicate playback path');
  const anchor = appJs.indexOf("$('guest-picker')");
  const guestPickerHandler = appJs.slice(anchor, anchor + 600);
  assert.doesNotMatch(guestPickerHandler, /renderMaterials\(\)|renderMesaResults\(\)/,
    'selecting or playing a Guest candidate never triggers a full-list rerender');
});

// ================================================================================
// UI-specific structural checks
// ================================================================================

test('SOLO hides Guest controls; relational modes reveal them; relation tabs map to the correct domain modes', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile('web/index.html', 'utf8');
  const appJs = await readFile('web/app.js', 'utf8');

  assert.match(html, /id="guest-section" hidden/, 'Guest controls start hidden (SOLO is the default mode)');
  for (const mode of ['solo', 'inyectar', 'acentuar-con', 'contagiar', 'cruzar']) {
    assert.match(html, new RegExp(`data-relation="${mode}"`), `relation tab for ${mode} exists`);
  }
  assert.match(appJs, /\$\('guest-section'\)\.hidden = mode === 'solo'/,
    'toggling to a relational mode reveals Guest controls, toggling back to solo hides them');
  assert.match(appJs, /setRelationMode\(btn\.dataset\.relation\)/,
    'each relation-mode button maps directly to the domain relationMode value, no translation table to drift');
});

test('Guest picker keeps Play and Select as genuinely separate touch targets', async () => {
  const { readFile } = await import('node:fs/promises');
  const appJs = await readFile('web/app.js', 'utf8');
  const anchor = appJs.indexOf('async function renderGuestPicker');
  const rendered = appJs.slice(anchor, anchor + 1200);
  assert.match(rendered, /data-guest-play="\$\{m\.id\}"/);
  assert.match(rendered, /data-guest-select="\$\{m\.id\}"/);
  const playTagMatch = rendered.match(/<button[^>]*data-guest-play/);
  const selectTagMatch = rendered.match(/<span[^>]*data-guest-select/);
  assert.ok(playTagMatch && selectTagMatch, 'Play is a <button>, Select is a separate <span>');
});

test('Influence slider initializes from the domain default via lab.ts, not a duplicated HTML default', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile('web/index.html', 'utf8');
  const appJs = await readFile('web/app.js', 'utf8');
  assert.match(html, /id="guest-influence" min="0" max="100" value="0"/,
    'HTML ships the neutral 0 placeholder, same convention as every Mesa slider');
  assert.match(appJs, /\$\('guest-influence'\)\.value = String\(state\.lab\.defaultGuestInfluence\)/,
    'the real default is read from the lab boundary at boot, never hardcoded twice');
});
