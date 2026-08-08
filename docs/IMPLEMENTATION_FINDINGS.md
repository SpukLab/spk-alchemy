# Implementation findings — first vertical slice

Where reality contradicted, refined or simply cost something the conceptual
architecture did not anticipate. Local reversible decisions are recorded here
rather than escalated, per the approved decision policy.

## F-1 — Repository inspection could not be performed

The implementation environment had no access to `SpukLab/spk-alchemy` and no
GitHub credentials (`gh` absent, no SSH key, no token). This repository was
therefore built greenfield from the consolidated baseline. **Inspection against
the real repository, and reconciliation of any contradiction, remains pending.**

## F-2 — Duplicate content is analyzed repeatedly (anticipated)

As predicted when UUID-per-import was adopted: the 100-material corpus contains
91 unique content hashes across 103 material entities, so identical bytes are
analyzed more than once. At this scale the cost is invisible. The reuse key is
already recorded on every Observation (`sourceContentHash`, analyzer agent ID,
analyzer version, analysis schema version), so the optimization is available
whenever it is wanted. Deliberately **not** implemented: a cache here would hide
provenance and versioning errors before there is confidence in either.

## F-3 — `produced_by_experiment` and `output_of` are semantically redundant

The baseline lists both, and Retain writes both. They carry identical meaning:
derived material → producing experiment. Implemented as specified, flagged here.
**Proposed ADR:** drop one before the relationship vocabulary is depended upon
by another domain. `output_of` reads better against `input_to`.

## F-4 — `observed_by` was not implemented

A Knowledge record already carries `subject` and `agentId`, so an `observed_by`
relationship would duplicate both with no added query power. Omitted. If
evidence-level provenance later needs its own history, it should be introduced
as a relationship at that point, with a reason.

## F-5 — Ancestor/descendant index usage is inverted relative to the baseline

The baseline states that ancestors use relationships indexed by target and
descendants by source. That holds only if `derived_from` points original →
derived. This implementation uses the semantically natural direction (derived →
original), so ancestors follow `adjacencyBySource` and descendants
`adjacencyByTarget`. Both indexes exist, so the choice is immaterial to
performance. Recorded because the baseline text will otherwise read as a
contradiction.

## F-6 — Imported materials enter as `promoted`

The lifecycle is specified for results of experiments. Import needed a decision.
An import is already a deliberate act by a human Agent, so imported materials
enter the Inventory directly as `promoted`, with an `import` Transition
recording provenance. Retain remains what it was defined to be: the boundary
from **runtime** to persistent identity, which import never crosses because an
imported file was never runtime state. Local and reversible.

## F-7 — Canonical WAV chosen precisely to make reproducibility testable

Container metadata is the usual source of nondeterminism in audio round-trips.
Rather than isolating it, the writer emits exactly one 44-byte canonical
RIFF/PCM16 header and nothing else. Bit-for-bit reproducibility is then a
property of the format. Double reversal returns the original bytes exactly.
Cost: only PCM16 WAV is supported. Decoding real-world files with `LIST`/`fact`
chunks works; re-encoding normalizes them away, which is a deliberate narrowing
to be revisited when real corpora arrive.

## F-8 — Zero dependencies, by accident then on purpose

`node:sqlite`, `node:test` and native type stripping removed every reason to
install anything. This eliminated the native-compilation risk of
`better-sqlite3` entirely. `node:sqlite` is an experimental API and may change;
the adapter boundary means replacing it costs one file. Recorded as a risk, not
a blocker.

## F-9 — The generic SQLite representation is a real cost

Two internal tables with hand-maintained index entries mean every `put` deletes
and rewrites that record's index rows. At 100 materials this is not measurable
(595 index entries over 240 records). At a corpus two orders of magnitude larger
it will be. The alternative — native indexes on generated columns — was rejected
because it breaks IndexedDB parity, which was the point. If this becomes a
bottleneck, the answer is a batched index-entry rewrite, not a change to the
portable contract.

## F-10 — One test bug, worth recording

The first architectural test for "no long-lived transaction" matched
case-insensitively and flagged the batch primitive `commit()` itself. The
assertion was wrong, not the design. Replaced with precise checks for SQL
transaction control, interactive transaction handles and callback-shaped commits.
The general lesson: architectural tests need to be as precisely worded as the
rules they enforce, or they produce false blockers.

## F-11 — The integrity audit is honestly a full scan

No index answers "which references are broken". `Q10` walks entities,
relationships, knowledge and the content store, paginated, off any interactive
path. Declared rather than disguised.

## Verification snapshot

- 37/37 tests pass: 14 conformance, 15 architectural, 8 integration.
- Corpus: 103 material entities, 91 unique content hashes, 11 duplicate-content
  groups, 102 promoted, 1 rejected, 10 observations, 15 relationships,
  106 transitions, 2 agents.
- `EXPLAIN QUERY PLAN` confirms indexed lookups resolve as
  `SEARCH ... USING PRIMARY KEY`, with no `SCAN` on any interactive path.
- Integrity audit clean: 0 dangling relationships, 0 orphan knowledge,
  0 materials with missing content, 0 unreferenced blobs.

## F-12 — Governance Canon authority and ADR renumbering

The foundation review numbered decisions conversationally; the Governance Canon
(`SpukLab/spuklab-canon`) uses its own continuous documentary sequence. The
persistence decision is **ADR-009** there, and this repository's
`docs/adr/ADR-008-persistence-portability-query.md` is a project-level
implementation reference rather than a normative ADR. Its header now states that
explicitly and no longer claims `ACTIVE` status, which only the Governance Canon
can confer.

This findings document is **project evidence**, not Governance Canon. It records
what implementation revealed; it does not establish rules.

Terminology: every occurrence of `canon` in this repository is the **Epistemic
Canon** — the Knowledge Graph epistemic stage. No code change was required, since
the term was never used here to mean the governance repository.

---

# Phase 2 — Material Exploration Loop

Findings are separated by epistemic weight, per the Governance Canon's own
distinction: what was measured, what the artist reported, what I inferred, and
what a future change might be. Nothing here is promoted directly into an ADR.

## Measured evidence

**M-1 — Actions from import to playback: two.** `seed` then `explore` produces
eight listenable WAV files plus a manifest. A single `corpus` command produces
the whole evaluation set. Generation of 8 variations from a 5000-frame source:
**38–41 ms**. Full corpus — 3 sources, 28 previews, 2 generations, 6 retentions,
7 promotions, 3 rejections — **96 ms**.

**M-2 — Variation distinctness is total at the byte level.** 28 previews, 28
unique content hashes, zero collisions. Fragment counts across one set ranged
3–8, so the structural spread is visible in the manifest without listening.

**M-3 — Reproducibility holds under the new configuration.** Identical source,
configuration id and version, parameters and seed produce bit-identical bytes.
Different base seeds produce zero overlapping hashes across sets.

**M-4 — Preview generation persists nothing.** Eight previews, zero new Material
Entities, zero Transitions. Retaining one of eight creates exactly one Entity;
the seven siblings leave no trace.

**M-5 — Two-generation genealogy resolves correctly.** A → B → C returns
ancestors in order at depths 1 and 2, and descendants of A return both B and C.
No special handling was needed: derived materials are ordinary Materials.

**M-6 — Configuration exposed to the artist: four flags.** `--material`,
`--variations`, `--seed`, `--output`. Everything else is derived from the seed.

**M-7 — Repeated-content analysis cost unchanged.** Still one analysis per
import regardless of shared content hashes, as recorded in F-2. Phase 2 did not
worsen it; exploration outputs are genuinely distinct, so the duplicate case did
not arise here at all.

## Artist feedback

**Not yet collected.** The corpus exists at `./evaluation` precisely so that
listening can happen. Whether variations are *perceptually* distinct, and
whether they remain related enough to form a future family, are questions the
numbers above cannot answer and this document must not pretend to.

## Inference

**I-1 — Byte distinctness is not perceptual distinctness.** 28 unique hashes
proves nothing about whether a listener can tell two variations apart. Fragment
reordering with silence insertion should be audible, but that is a hypothesis
until someone listens.

**I-2 — Imported-as-promoted did not cause confusion in this phase.** Every
exploration begins from a promoted material, so the Inventory was always
non-empty and the loop never stalled. The convention remains local and
reversible, per F-6. No evidence yet argues for an `available` state; adding one
now would be speculative.

**I-3 — The manifest is doing staging work.** Because the CLI is one process per
command, the manifest bridges runtime Preview Sets across invocations. It is not
persistence — it holds no canonical record and deleting it loses nothing
canonical — but it is a boundary worth watching. A browser UI holding the
Preview Set in memory would not need it.

## Evidence on relationship redundancy

**F-3 confirmed with usage data.** Across the whole codebase:

- `output_of` is **read** in `src/query/queries.ts` (experiment inputs/outputs).
- `produced_by_experiment` is **written** in `service.ts` and **never read**.

Both carry the same source, the same target and the same direction, answering
the same question: which experiment produced this material. `output_of` is fully
derivable from `produced_by_experiment` and vice versa.

**No change made.** Removing either would invalidate relationships already
written in the existing corpus without a migration plan, and schema change is
outside this phase. The finding is recorded for a focused ADR amendment with a
migration, not a silent cleanup.

## Evidence toward future abstractions

**Research Method / Workbench.** One configuration was enough for this phase. A
second one would immediately raise the question the Canon already anticipates:
whether a reusable configuration is *knowledge* (Method) or *runtime surface*
(Workbench). No evidence yet demands either. The right trigger is a second
configuration that the artist actually wants to reuse and name, not a third
architectural discussion.

**Family / DNA Pack contract.** Seven promoted materials now exist with shared
provenance — same configuration, same intent, adjacent seeds. That is the raw
material of a family. Nothing yet requires the contract; it becomes necessary
when something downstream needs to consume the group.

## Test bug worth recording

**F-13 — Two architectural assertions produced false positives**, both of the
same class as F-10. One matched the word `SELECT` inside an English sentence
("select or reorder fragments"); the other matched `Math.random` inside a
comment saying the code must not use it. Both assertions were tightened to
inspect SQL syntax and executable code rather than prose, and both were verified
to still catch the real thing. The recurring lesson: an architectural test that
greps prose will eventually block work for the wrong reason.

---

# Phase 3 — iPhone Capture & Exploration Slice

## Measured evidence

**M-8 — The IndexedDB adapter passes the conformance suite unmodified: 14/14.**
Same file, same expected semantics, no adapter-specific allowances. Plus 4 new
equivalence tests proving both adapters return identical results for the same
operations, including adversarial keys, keyset pagination sequences and
adjacency ordering.

**M-9 — The suite caught two real adapter defects before any device saw them.**
Both were in keyset pagination:

1. `nextAfter` was decoded by scanning backwards for a `0x00` separator in the
   composite entry key. Encoded string components legitimately contain `0x00`,
   so the scan found the wrong boundary. Fixed by carrying the ordering key in
   the entry value instead of reparsing it out of the key.
2. The `after` bump appended `0x00`, which is a *prefix* of the matching entry
   key (`scoped + 0x00 + recordId`) and therefore included the record the caller
   had already seen. Fixed with `0x01`, which sorts above any separator.

Neither is visible without a second engine. This is precisely the evidence
ADR-009 was waiting for.

**M-10 — The canonical core was not as portable as its purity test claimed.**
`src/core/ids.ts` imported `node:crypto`. The purity test explicitly allowed it
on the assumption that Web Crypto was an equivalent, but `crypto.subtle` is
asynchronous and `contentHash` is synchronous throughout the domain. The bundler
surfaced this immediately: `Could not resolve "node:crypto"`.

Replaced with a pure synchronous SHA-256 in `src/core/sha256.ts`, verified
byte-identical to `node:crypto` across **all 301 lengths from 0 to 300 bytes**
plus 40 pseudo-random payloads. This mattered: a divergent hash would have
silently invalidated every content identity already stored.

That verification found a third defect — a padding-boundary bug that only
appears when `length + 9` is an exact multiple of 64 (e.g. 55 bytes). Every
other length was correct, so only a boundary-aware test could see it.

**M-11 — Browser bundle: 70.9 KB, zero Node builtins.** The same canonical core,
domain service and query layer the CLI uses; only the adapters differ.

**M-12 — Recording format is detected, not assumed.** Preference order is PCM,
then ALAC, then WebM/Opus, then the device default, resolved through
`MediaRecorder.isTypeSupported()`. Lossless recording (ALAC and PCM) shipped in
Safari 18.4, not 26 as first assumed; 18.4 is therefore the meaningful floor,
and the code degrades to AAC below it without branching downstream.

## Environment caveat — the honest limit of this phase

**No test has run on an iPhone.** The conformance suite runs against a
spec-compliant IndexedDB implementation in Node, not Safari. What is proven:
the adapter satisfies the portable contract and agrees with SQLite on observable
behaviour. What is NOT proven: that Safari's IndexedDB, its transaction
auto-commit timing, its `getUserMedia` permissions flow, its
`decodeAudioData` behaviour on captured MP4/ALAC, and its home-screen install
path all behave as expected on a real device.

Those are exactly the things a container cannot check. Until the app is opened
on the phone, this phase is *implemented*, not *validated*.

## Inference

**I-4 — ADR-009's activation criterion is close but not met.** Conditions 1, 2
and 3 have evidence: an IndexedDB adapter exists, passes the same suite, and
matches Node's observable semantics. Condition 4 also holds — no canonical
schema or query-layer redesign was needed; the two pagination fixes were inside
the adapter, and the hashing change was a portability defect in the core rather
than a contract change.

But the evidence comes from a Node-hosted IndexedDB. My recommendation is to
hold ADR-009 at `EXPERIMENTAL` until the app runs on the device, then promote it
with device evidence rather than harness evidence. That is a judgement call and
the decision is the owner's.

**I-5 — The manifest staging file (I-3) is now unnecessary on the phone.** The
browser holds the Preview Set in memory across the whole loop, exactly as the
runtime model intended. The CLI still needs it because it is one process per
command. The two surfaces exercise the same domain differently, which is a
useful signal that the runtime/persistent boundary is drawn in the right place.

## Proposed change

None yet. Every finding above is either already fixed or a decision for the
owner. Nothing here demonstrates a structural requirement that would justify
opening a new ADR.

## Device evidence — first real iPhone test

**M-13 — The deployed app failed on the device: `Can't find variable: Buffer`.**
Node's `Buffer` global had leaked into the canonical core through
`src/persistence/keys.ts` (key encoding) and `src/audio/wav.ts` (the WAV codec).
The page loaded and rendered, but `openLab()` threw before IndexedDB was ever
reached, so nothing worked.

This is the **second** instance of the same failure mode as M-10, and the reason
is worth stating plainly: the purity test checked `import` statements only.
Node globals require no import, so they pass a bundler check and every test in
Node, then fail on the first real device. `node:crypto` was caught by esbuild
because it is an import; `Buffer` was not, because it is not.

Both modules were converted to `Uint8Array`, `DataView` and
`TextEncoder`/`TextDecoder`. Byte-identity was verified against golden vectors
captured before the change — 12 key encodings including empty components,
prefix-like strings, embedded NUL, characters beyond the BMP, negative and
boundary integers, plus 3 WAV encodings. Any divergence would have invalidated
every stored index key and content hash.

The purity test now also bans Node globals (`Buffer`, `process`, `__dirname`,
`__filename`, `require`, `global`) in portable layers, and browser globals in
the core, with `ArrayBuffer` and the `system_process` agent kind explicitly not
treated as matches. A boot probe additionally loads the built bundle with
`globalThis.Buffer` deleted, which is the condition Safari actually presents.

**Still pending on the device:** microphone permission, recording, playback,
ingestion, exploration, retention, persistence across reload, and Home Screen
install. The first device test got as far as page load, which is itself new
information: the shell, styling, layout and service worker all worked.

**M-14 — The app boots on a real iPhone. Build `57aa16a`, all capabilities green.**

| Capability | Result |
|---|---|
| Secure context (HTTPS) | yes |
| IndexedDB | yes |
| navigator.mediaDevices | yes |
| getUserMedia | yes |
| MediaRecorder | yes |
| Audio decoding | yes |
| Accepted recording types | `audio/mp4; codecs=alac`, `audio/mp4`, `audio/webm; codecs=opus`, `audio/webm` |
| Format selected | `audio/mp4; codecs=alac` (lossless) |
| Storage | IndexedDB (local) |
| Standalone mode | no (Safari tab, not yet installed) |
| Storage quota | 0.1 MB used of 39,322 MB |

**Notably, this device does NOT accept `audio/wav`.** Runtime detection picked
ALAC, so capture is lossless anyway. Had the recording format been hardcoded to
PCM WAV — the obvious choice given the canonical representation is PCM16 WAV —
capture would have failed outright on this phone. The preference-order detection
in `detectRecorderCapability` is doing real work, not defensive decoration.

The ~39 GB quota means storage is not a near-term constraint for a local corpus.

**M-15 — A cache-first service worker pinned the device to a broken build.**
After the Buffer fix was deployed and verified on the server, the phone kept
failing with the identical error. The deployed `lab.js` had zero `Buffer`
references; Safari was serving the previous one from the service worker cache,
and cache-first meant the fix could never win.

Application code is now network-first with a cache fallback; only immutable
assets stay cache-first. Offline still works. The failure mode this removes is
worse than the one it protects against: an offline app is inconvenient, an
un-updatable broken app is unusable. A visible "clear cache and reload" control
and the running build id in the header make the state diagnosable from the
device.

**Still pending:** microphone permission prompt, recording, playback, ingestion,
exploration, retention, persistence across reload, and Home Screen install.
Boot and capability detection are confirmed; the artistic loop is not.

## Device evidence — import interoperability

**M-16 — Root cause: `accept="audio/*"` filtered files by UTI, not by decode capability.**
The recording, exploration and playback loop worked correctly on the real
device, confirming the earlier fixes. But WAV and AIFF files exported from
Sound Forge could not be **selected** in Safari's file picker: `accept="audio/*"`
on iOS filters the Files browser by a UTI it infers from the attribute, and
third-party audio exports frequently lack a UTI Safari recognises as strictly
`public.audio`. The file never reached any application code — `normalizeToCanonicalWav`
never even ran, because nothing was ever selected.

This was a pure UI-layer defect. The decode boundary itself was already format-
agnostic and had never filtered by MIME.

**Fix.** `accept` now lists explicit extensions alongside the generic types:
`.wav,.wave,.aif,.aiff,.m4a,.mp4,.caf,audio/*,video/mp4`. Extension and MIME
remain hints only, surfaced through `describeImportCandidate` for a friendlier
error message — never used to reject a file. The only authoritative check is
`decodeImportedFile`, which attempts a real decode and throws a named
`ImportDecodeError` on failure, before anything is created.

**Structural fix, not just a wider list.** `PREFERRED_MIME_TYPES` (recording)
and file import validation now live in separate modules —
`capture-format-policy.ts` and `import-decode-policy.ts` — so a future change to
recording codecs cannot silently narrow what files can be imported again. That
coupling, even though it was never exercised in code before this fix, was
exactly the shape of bug that produced M-16 in the first place: two unrelated
questions sharing one answer.

**Tests:** 11 new, covering WAV/AIFF with normal and empty/unusual MIME,
existing M4A import, a named decode failure, zero IndexedDB writes on failure,
successful entry into Exploration, survival across a store reopen, and a
regression check that capture-format detection still selects ALAC on the exact
capability profile M-14 reported from the device.

**Still pending on the device:** select a real WAV exported from Forge, confirm
it becomes the active source, run Explorar, retain one, reload Safari, confirm
persistence. Repeat with a real AIFF file. Recording and exploration are already
confirmed working (M-14); only the import path needed this fix.

## Gain consistency refinement (fragment-exploration-v1@1.1.0)

**Artist feedback** (kept separate from measured evidence, per the Canon's own
distinction): "Variations are useful and distinct. Overall gain variation is
slightly too broad; preserve volume character but narrow the listening-level
range."

### Baseline measurement, before any change

Reference corpus: one 5000-frame synthetic source, 8 variations, base seed
1000, `fragment-exploration-v1@1.0.0`, gain applied per-fragment only (existing
decaying numerator, unchanged):

| Variation | Peak | RMS | Clipped |
|---|---|---|---|
| v0 | 0.2580 | 0.0745 | 0 |
| v1 | 0.3403 | 0.0822 | 0 |
| v2 | 0.3403 | 0.0988 | 0 |
| v3 | 0.2859 | 0.0940 | 0 |
| v4 | 0.4537 | 0.1327 | 0 |
| v5 | 0.3690 | 0.0787 | 0 |
| v6 | 0.3060 | 0.0720 | 0 |
| v7 | 0.1906 | 0.0667 | 0 |

RMS range 0.0667–0.1327 (**6.0 dB spread**, ~2× ratio). Zero clipping already —
the defect was inconsistency, not distortion.

### Correction model chosen

Per-fragment gain shaping (fragment, reorder, reverse-subset, space, decaying
gain) is **untouched** — that is what gives each variation its internal
dynamic character and the artist confirmed it should stay. One deterministic
correction is added **after** reconstruction:

1. Measure the completed Preview's peak and RMS (that Preview alone — never
   its siblings).
2. Compute the *ideal* correction toward a fixed target (`PREVIEW_TARGET_RMS =
   0.09`, chosen because it sits near the middle of the observed baseline
   range) — in dB, since dB is the perceptually linear unit.
3. **Apply only 65% of that distance** (`PREVIEW_GAIN_PULL_STRENGTH`). A full
   snap-to-target was tried first and rejected: every Preview measured
   *exactly* 0.0900 RMS, a flat 0 dB spread — which is explicitly not the
   goal ("do not make every result equally loud"). A partial pull narrows the
   spread substantially while every Preview still measures audibly
   differently from its siblings.
4. Clamp the applied correction to ±4 dB (`PREVIEW_GAIN_MAX_BOOST_DB` /
   `PREVIEW_GAIN_MAX_CUT_DB`).
5. Re-check the *projected* peak against a safety ceiling
   (`PREVIEW_PEAK_CEILING = 0.97`); if the correction would push it over,
   reduce the correction to exactly clear the ceiling. Safety always wins over
   the target.
6. Apply one multiply to every sample, uniformly across channels (so stereo
   balance is preserved exactly), round, clamp to int16 range.

No compressor, no limiter, no multi-band processing — one measured global
factor per Preview.

### Result on the same reference corpus

| Variation | Peak | RMS |
|---|---|---|
| v0 | 0.2918 | 0.0842 |
| v1 | 0.3610 | 0.0872 |
| v2 | 0.3203 | 0.0930 |
| v3 | 0.2780 | 0.0914 |
| v4 | 0.3526 | 0.1031 |
| v5 | 0.4025 | 0.0859 |
| v6 | 0.3538 | 0.0832 |
| v7 | 0.2314 | 0.0811 |

RMS range 0.0811–0.1031 — **6.0 dB → 2.1 dB**, roughly a 3× reduction in
spread. Zero clipping. Every value still distinct.

### Bound verification (isolated correction step, not conflated with fragment shaping)

- Silence in → correction = 1 exactly, RMS stays 0, no NaN/Infinity.
- Near-silent probe signal (raw RMS 0.00033): correction = **+4.00 dB**
  exactly — the boost bound, not runaway gain.
- Near-full-scale probe signal (raw peak 0.68): correction = **−4.00 dB**
  exactly — the cut bound.
- Signal at raw peak 0.998 (essentially clipping already): projected peak
  after the −4 dB bound would still exceed the ceiling, so the peak-safety
  step engaged and produced a final peak of 0.6296 — comfortably under 0.97,
  zero clipped samples.

### Configuration versioning

`fragment-exploration-v1@1.0.0` is byte-for-byte unchanged — verified against
golden hashes captured before this change. `fragment-exploration-v1@1.1.0` is
a new configuration object with the same `id`, bumped `version` and
`implementationVersion`, and one added operation step
(`preview-gain-correction`) in its declared sequence. `DEFAULT_FRAGMENT_EXPLORATION`
now points at 1.1.0 and is what every new exploration in the CLI, the
evaluation corpus and the web app uses. `configurationById(id)` without a
version resolves to the default; `configurationById(id, '1.0.0')` still
resolves the original, byte-identical configuration.

**A pre-existing latent bug was found and fixed in the same change:**
`previewFromManifest` resolved a manifest's configuration by id only, then
attributed the rebuilt Preview's `configurationVersion` to whatever that
lookup returned — silently correct while only one version existed, but wrong
the moment two did (an old 1.0.0 manifest would have been retained as if it
were 1.1.0). It now resolves by `(id, manifest.configurationVersion)` and
attributes the Preview using the manifest's own recorded version, never the
resolved configuration's version.

### Tests

14 new tests: 1.0.0 hash preservation, 1.1.0 determinism, bit-identical
same-seed reproduction, Preview-set independence (one alone vs. inside eight),
measured spread reduction (6.0→2.1 dB, and generically "substantially
narrower"), continued presence of internal spread (not flattened to one
value), silence handling, bounded upward correction, bounded downward
correction, zero clipping across the corpus and adversarial inputs, stereo
channel-ratio preservation, Retain provenance recording `1.1.0`, and
`(id, '1.0.0')` resolution reproducing the exact original hashes.

### Two implementation bugs found and fixed during this change, not part of the gain model itself

- **Purity-test false positives (F-13 pattern, again).** The word "global"
  inside a string literal describing the new operation
  (`'one deterministic global gain factor...'`) tripped the Node-globals
  check added after the Buffer incident. The check stripped comments but not
  string/template literal contents. Fixed by stripping those too, verified to
  still catch real `Buffer.from(...)` and `process.env` usage.
- **A missing import silently passed a syntax check.** An earlier edit to
  `src/web/lab.ts` left `DEFAULT_FRAGMENT_EXPLORATION` used but never
  imported. `node --experimental-strip-types -e "import(...)"` reported "ok"
  because the reference lived inside function bodies never executed by that
  probe — Node doesn't statically verify unresolved bindings, only syntax.
  The bug surfaced only when the built bundle's `openLab()` was actually
  *called* in a boot probe. Recorded because it is the same category of gap
  as M-10/M-13/M-16: a check that passes without exercising the actual
  runtime path is not evidence the path works.

## Slice-boundary micro-fade refinement (fragment-exploration-v1@1.2.0)

**Artist feedback** (kept separate from measured evidence): "Exploration
variations are working well after the gain refinement. The remaining issue is
that some fragment cuts are perceptually too abrupt. A micro-fade is desired
at slice boundaries, similar to de-click treatment previously needed in
Freeze/Slice workflows."

### Original boundary behavior

Fragment pieces (sliced, optionally reversed, gain-shaped) are concatenated in
permuted order, with occasional silence inserted between them. Every
concatenation point — fragment-to-fragment directly, fragment-to-silence, and
silence-to-fragment — was a raw sample abutment: whatever value ended one
piece sat directly next to whatever value began the next, with no treatment.

### Baseline discontinuity measurement

Reference corpus: 8 variations of `fragment-exploration-v1@1.1.0`, same
5000-frame synthetic source, base seed 1000. Metric:
`abs(lastSample(pieceA) − firstSample(pieceB)) / 32768` per boundary.

- **82 boundaries** across the 8 variations
- Mean discontinuity: **0.0615** (6.15% of full scale)
- Max discontinuity: **0.3121** (31% of full scale)
- Exceeding a 0.05 diagnostic threshold: **32 of 82 (39%)**
- This is diagnostic only — it does not define artistic quality, but it does
  confirm the artist's perception was not imagined: real, large, untreated
  jumps exist at nearly 4 in 10 boundaries.

### Fade model chosen

`PREVIEW_BOUNDARY_FADE_MS = 5`, converted per source sample rate:
`fadeFramesForSampleRate(sr) = round(sr * 5 / 1000)` — 221 frames at 44.1kHz,
exactly 240 at 48kHz. Verified sample-rate independence in perceptual duration
rather than a hardcoded frame count.

**Short-fragment rule:** each side of the fade is independently capped at
`floor(fragmentFrameCount / 4)` inside `applyBoundaryFade` itself — the single
source of truth, not duplicated at call sites. This guarantees fade-in and
fade-out can never overlap (their combined maximum is at most half the
fragment) and lets very short fragments degrade gracefully to zero fade rather
than being rejected or producing an error.

**Boundary rule, uniform across all three shapes:** every non-silence piece
fades out unless it is the very last element of the Preview, and fades in
unless it is the very first. This one rule, applied per-piece by only asking
"does a neighbour exist," produces the correct treatment for all three
boundary shapes without special-casing any of them:

- fragment → fragment (no gap): both pieces fade, toward each other.
- fragment → silence: only the outgoing fragment fades (toward the existing
  zero-valued silence, which is never itself modified).
- silence → fragment: only the incoming fragment fades (from zero).

Reversed fragments receive identical treatment — the fade is applied after
reversal and gain shaping, on whatever samples the piece contains by then; it
has no awareness of whether the piece was reversed.

Curve: simple linear ramp, frame-indexed, same coefficient applied to every
channel of a frame (`out[frame][channel] = round(sample * gain)`), so stereo
balance cannot shift.

### Final operation order for 1.2.0

```
fragment → permute/select → reverse where selected → per-fragment gain shaping
  → boundary micro-fade (new)
  → concatenate with silence exactly as before
  → measure completed Preview energy
  → 1.1.0 gain-consistency correction (65% pull, ±4dB, peak safety) — unchanged
  → canonical WAV
```

This matches the recommended ordering exactly: the fade operates on each
piece before concatenation and before the Preview-level gain measurement, so
the existing 1.1.0 correction still measures (and corrects) the final,
already-faded signal — consistent with how it already treats whatever bytes
reach it.

### Configuration version

`fragment-exploration-v1@1.2.0`. `1.0.0` and `1.1.0` are byte-for-byte
unchanged — both `renderVariation` (1.0.0/1.1.0's shared fragment-shaping
function) and `renderVariationV1_1` were not modified; `renderVariationV1_2`
is a new, separate function that duplicates the fragment-assembly loop rather
than parametrizing the existing one, specifically so a bug in the new fade
logic has zero path to affect the older versions. `DEFAULT_FRAGMENT_EXPLORATION`
now points at 1.2.0; `configurationById(id)` without a version resolves there,
`configurationById(id, '1.0.0')` and `(id, '1.1.0')` still resolve their exact
original configurations.

### Before / after, same reference corpus

| | 1.1.0 (no fade) | 1.2.0 (faded) |
|---|---|---|
| Boundary discontinuity, mean | 0.0615 | 0.0008 |
| Boundary discontinuity, max | 0.3121 | 0.0078 |
| Exceeding 0.05 threshold | 32 / 82 (39%) | 0 / 82 (0%) |
| Output duration | unchanged | unchanged (bit-for-bit frame counts) |
| RMS spread across 8 variations | 0.0220 | 0.0219 |
| Clipped samples | 0 | 0 |
| Unique output hashes | 8 | 8 |

Discontinuity dropped by roughly 98% (mean) and 97% (max) with duration
exactly preserved, gain-consistency spread essentially unchanged (within noise
of the fade itself very slightly reducing energy near boundaries), zero
clipping, and full variation preserved — no two variations collapsed toward
the same result.

### Tests

22 new: 1.0.0 and 1.1.0 hash preservation, 1.2.0 determinism, fade-duration
conversion at 44.1kHz and 48kHz, frame alignment, uniform per-frame
multichannel coefficient, all three boundary shapes (fragment-fragment,
fragment-silence, silence-fragment), reversed-fragment equivalence,
short-fragment safe reduction, non-overlap of fade-in/fade-out, unchanged
duration and channel count, zero clipping, gain-consistency envelope
preserved, same-seed determinism, cross-seed distinctness, exact-version
retainability of 1.0.0/1.1.0, 1.2.0 Retain provenance, and a measured-evidence
test reproducing the ~98%/~97% discontinuity reduction directly (not just
asserted in prose).

### Verified through the real deployable path

`node build.mjs` produced the browser bundle; `openLab()` was called against
that built `dist/lab.js` with `globalThis.Buffer` deleted (the condition
Safari presents) and reported `explorationConfiguration:
{"id":"fragment-exploration-v1","version":"1.2.0"}`. Full IndexedDB
integration suite green against the same bundle path.

## Family Curation and First DNA Pack

**Artist context:** fragment-exploration-v1@1.2.0 is stable and physically
validated; the loop now turns discovered material into usable output.

### Canonical mapping

No new structural primitive was introduced. Both concepts already existed as
canonical types in ADR-005 and the glossary, unimplemented until this phase:

**Family → Canonical Grouping.** A Family is an Entity (`type:
'family-grouping'`, `role: 'grouping'`, single lifecycle state `active`, no
transitions out of it) plus reified `grouped_in` Relationships (Material →
Family, one per member, `metadata.order` carrying position). Membership edits
never touch the Family Entity's identity: `addMember`/`removeMember` add or
delete one Relationship; `reorderMembers` re-puts existing Relationships with
updated `order` only. Every edit bumps `attributes.revision` on the Family
Entity — a monotonic, deterministic counter used as the "Family
version/revision identifier" in DNA Pack manifests, chosen over relying on
`updatedAt` because a counter is exact and testable, a timestamp is not.

**DNA Pack → Published Artifact.** An Entity (`type: 'dna-pack'`, `role:
'publication'`, single lifecycle state `published`, no transitions — immutable
by construction, not by convention) plus a `published_from` Relationship
(DNA Pack → Family, carrying `packVersion`) and one `packaged_material`
Relationship per exported member (DNA Pack → Material), mirroring the frozen
manifest snapshot so pack contents stay queryable like any other genealogy.
Publication is recorded as one `publish` Transition.

No Canon change was necessary — both types were already specified; this phase
only implemented the code the glossary and ADR-005 already anticipated.

### Family identity preservation

Verified structurally, not just by convention: `addMember`, `removeMember` and
`reorderMembers` all return `void` and never construct a new Family UUID; the
one Entity created at `createFamily` is the only Family Entity that ever
exists for that grouping. Tests 4–8 assert `family.id` is unchanged across
every edit type.

### Persistence

No new index was needed. The existing `ent_by_role_lifecycle` index
(`[role, lifecycleState, createdAt, id]`) already covers listing Families
(`role='grouping'`) and DNA Packs (`role='publication'`) directly — "do not
redesign RecordStore" was satisfied automatically rather than by restraint.
Family size in this phase is small by design (a curated set an artist
listens through, not a database), so ordered members are read via
`adjacencyByTarget` and sorted client-side rather than requiring a new
order-aware index.

SQLite/IndexedDB equivalence for the Family path (creation, reorder,
persistence) is covered by test 10 rather than a new conformance-suite
addition — the existing suite already proves the adapters agree on ordering,
adjacency and pagination in general; this phase only needed to confirm Family
specifically exercises that already-proven path correctly, which it does.

### DNA Pack content and versioning

Audio bytes pass through unchanged — `content.get(hash)` for each member,
zero transformation. Every export is already canonical PCM16 WAV regardless of
whether the source arrived as a microphone capture, WAV, AIFF or M4A import:
verified byte-for-byte against the stored content hash (test 15).

Versioning is a plain incrementing integer per Family, computed by counting
existing `published_from` relationships targeting that Family at publish time
(`count + 1`) — no counter to keep in sync, no race between two fields
disagreeing. Chosen over semver-style versions because nothing in this phase
produces a meaningful minor/patch distinction; a pack is either version N or
it isn't yet.

Manifest schema (`schemaVersion: 1`): pack id/version, family id, family
revision, family name, publication timestamp, publishing Agent, and one entry
per member with order, exported filename, canonical content hash, duration,
sample rate, channels, origin, and ResearchConfiguration id/version/seed when
the member was itself an exploration result. Deliberately excludes the
Knowledge Graph, Agent records beyond the publishing Agent's id, and any
internal Relationship — "a portable artifact contract, not a database
backup," per the brief.

### Export mechanism

A hand-rolled, dependency-free, deterministic ZIP writer (STORE method, no
compression — canonical WAV is already compact PCM16, and a compression
library would be the one new dependency this whole project has avoided).
Verified against the system `unzip` binary, not just round-tripped through its
own reader: `unzip -l` and `unzip -p` both read the generated archive
correctly. Identical inputs produce byte-identical ZIP output — no wall-clock
timestamps, a fixed DOS epoch instead.

Browser delivery: an anchor-element download (`URL.createObjectURL` +
synthetic click), which always exists as a plain download path per the brief.
`navigator.share()` with files is offered as an *additional* action only when
`canShare({ files })` reports true at runtime — never required, matching the
capability-detection pattern already established for recording formats.

### Files added

`src/format/zip.ts`, `src/domain/alchemy/family-service.ts`,
`src/domain/alchemy/dna-pack.ts`, `tests/integration/family-and-dna-pack.test.ts`.

### Files modified

`src/domain/alchemy/vocabulary.ts` (Family/DNA Pack types, roles,
relationships, transition kinds), `src/web/lab.ts` (FamilyService wiring and
seven new WebLab methods), `web/index.html` (curation UI, Family detail
overlay, material picker overlay), `web/app.js` (selection mode, Family
rendering, playback, reorder, publish/download/share).

### Artistic validation — not yet collected

The questions the brief asks (does grouping feel natural, is audition fast
enough, does a Family feel like a meaningful unit, is a DNA Pack immediately
usable outside Alchemy) require the physical checklist below. Nothing here is
measured evidence about creative quality — only that the mechanism works.
