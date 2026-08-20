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

## Fix: duplicate DNA Pack download on iPhone

### Root cause, confirmed by direct inspection

`publishFamily()` in `web/app.js` called `downloadBlob(...)` **unconditionally**,
then — if `navigator.share` and `navigator.canShare` were available — **also**
called `navigator.share(...)`. One button press triggered both native export
paths every time sharing was supported, which it is on iPhone Safari: the
anchor download fired, and the share sheet opened over it. Safari's own
download confirmation stayed queued behind the share sheet; accepting it after
dismissing the share sheet downloaded the same ZIP a second time.

There was no single-flight guard either: nothing prevented a rapid double-tap
from calling `state.lab.publishFamily(...)` — the canonical action that
creates a new pack version — twice.

### Previous call sequence

```
Publicar DNA Pack (tap)
  → state.lab.publishFamily(familyId)      [creates pack, canonical]
  → downloadBlob(...)                       [anchor .click()]
  → navigator.canShare(...) ? navigator.share(...)   [ALSO fires, unconditionally]
```

### Corrected sequence

Two independent, mutually exclusive actions, coordinated by a new
`DnaPackExportController` (`src/web/export-orchestrator.ts`) — pure, dependency-
injected, unit-testable in Node without a DOM:

```
Publicar DNA Pack (tap)
  → single-flight guard (ignore if a publish is already in flight)
  → state.lab.publishFamily(familyId)      [canonical action, called at most once]
  → downloadBlob(...)                       [the ONLY export this button ever performs]
  → (artifact bytes retained for a possible later Share)

Compartir último pack (tap, separate button, shown only when supported)
  → single-flight guard (independent of Publish's guard)
  → navigator.share(...) on the ALREADY-published bytes  [never re-publishes, never downloads]
```

The controller enforces this structurally, not by convention: `publishAndDownload`
is the only method that calls the canonical publish action and the only one
that calls `download`; `shareLast` is the only method that calls `share`, and
it has no code path that calls `download` — success, cancellation and failure
all return without touching the download function at all.

### UI decision

Kept the single primary Publish button (download-by-default, matching "if
keeping the current single-button flow is substantially simpler, choose
exactly one primary action") and added a separate, secondary **Compartir
último pack** button that appears only after a successful publish and only
when `navigator.canShare({ files })` reports true for that exact artifact.
Opening a different Family or closing the Family screen resets the controller
(`exportController.reset()`), so a stale artifact from a previous Family can
never be shared by mistake.

### Single-flight guard

UI-level only, exactly as scoped: two independent boolean flags inside the
controller (`#publishing`, `#sharing`), each guarding its own action. A
duplicate tap while busy is **ignored outright** — `publishAndDownload`
returns `null`, `shareLast` returns `'unavailable'` — never queued, never
retried. No canonical state was added; the guarded action still creates
exactly one Published Artifact per successful call, unchanged from before.

### Verified unchanged

ZIP format, manifest schema, Family/DNA Pack canonical mapping, pack
versioning, and `fragment-exploration-v1@1.2.0` were not touched. A dedicated
test publishes a pack, then runs an export interaction, and asserts the
Family's `revision` attribute and the previously-published pack Entity's
`attributes` are byte-identical to before — export is entirely client-side
work on already-fetched bytes and never reaches canonical persistence.

### Files added

`src/web/export-orchestrator.ts`, `tests/integration/dna-pack-export.test.ts`.

### Files modified

`web/app.js` (controller wiring, `publishFamily` rewritten to use it,
`shareLastPack` added, controller reset on family open/close), `web/index.html`
(Share button), `web/service-worker.js` (precache the new bundle),
`build.mjs` (second esbuild entry point for the self-contained orchestrator
module).

### Verified through the real deployable bundle

Built `dist/export-orchestrator.js` as a standalone bundle (self-contained,
no imports of its own — folding it into `lab.js` was unnecessary). Loaded both
`dist/lab.js` and `dist/export-orchestrator.js` with `globalThis.Buffer`
deleted and mock `download`/`share` functions: `publishAndDownload` produced
exactly one download and zero shares; a subsequent `shareLast` produced
exactly one share and no additional download.

## iPhone UX refinement: Family selection, Material audition, lineage colors

**Physical artist feedback:**
- Family selection works but currently requires an unnecessary manual switch to Promovidos.
- Material cards need direct playback because the artist sometimes works with samples without remembering their sound.
- A visual lineage marker would reduce cognitive load when many related variations exist.

Classified as UX/artistic-use evidence, not architectural requirements — nothing
here changed a canonical contract.

### 1. Family selection friction

Root cause: activating selection mode toggled `state.curating` without also
switching `state.tab`, so the artist had to tap "Promovidos" manually every
time. Fixed: the toggle handler now sets `state.tab = 'promoted'` whenever
selection is activated from a different tab. Deactivating selection makes no
change to the tab — a reversible, minor decision, since returning to whatever
the artist was looking at is the less surprising default.

### 2. Material card playback

Reused the existing single-player infrastructure from the Family screen
(`stopPlayback`/audio element) instead of building a second player: the
Family screen's `playMember` became `togglePlayMaterial`, called from both the
Materials list and the Family screen, with a shared `refreshPlaybackViews()`
that re-renders whichever view is currently visible.

**Playback source resolution:** always `content.get(material.attributes.contentHash)`
— the same canonical Content path Retain and DNA Pack export already use.
Never derived from Preview staging: a Preview has no persistent id to resolve
by the time the artist is looking at a Material card. Verified this survives a
store reopen (test 7) using only persisted data, no live session state.

**Rejected Materials are included**, since rejection never deletes canonical
Content — `material(id)` now checks promoted, retained and rejected in that
order.

**Single active player:** starting playback always calls `stopPlayback()`
first, unconditionally, before creating a new `Audio` element — verified by a
structural test locating that ordering in the actual function body, since a
DOM-level unit test would have meant adding a testing dependency (jsdom) this
project has deliberately avoided everywhere else. Leaving a tab stops playback
too, so navigating never leaves overlapping audio running.

**Hit-target separation:** the Play button is a DOM sibling of the selection
`<label>`, never nested inside it, so tapping Play can never also toggle the
checkbox through native label semantics — and the materials click handler
resolves and returns on a play tap before any selection-related branch can
run. Verified structurally against the actual rendered markup and handler
source, not just visually.

### 3. Lineage colors

`src/domain/alchemy/lineage.ts` — pure derivation, no persistence, no
canonical primitive, no ADR:

- **Root resolution:** a Material with zero ancestors is its own root;
  otherwise the ancestor at maximum depth in the existing `ancestors()`
  traversal is the root (that traversal already orders by depth). No new
  query was needed.
- **Multi-root fallback (documented per the brief's explicit ask):** the
  current exploration engine only ever derives from one input Material at a
  time, so every derived Material has exactly one ancestry chain in practice.
  The general case is still handled: if the ancestor set contains more than
  one node at the maximum depth (multiple independent roots), candidates are
  ordered by `(depth desc, id asc)` and the first is used, with the neutral
  `MULTI_ROOT_COLOR` (`#8b8b96`, matching `--dim`) used instead of guessing a
  blend. Verified deterministic across repeated calls with an injected
  synthetic multi-parent case, since the current DSP cannot produce one
  naturally.
- **Palette:** 10 hex colors chosen for the dark UI, deliberately distinct
  from `--accent` (promoted tab / explore / status) and `--ok`/`--danger`
  (the keep/reject buttons) — a lineage color must never read as a lifecycle
  signal.
- **Mapping:** `sha256(rootId)` (the same portable hashing already used for
  content identity), first 4 bytes as a uint32, mod palette size. Deterministic
  by construction; no persistence needed, so none was added — the brief's
  "prefer derivation unless persistence is genuinely necessary" applied
  cleanly here since the root id alone is sufficient input.
- **Independence verified explicitly:** Promote, Reject, Family membership and
  DNA Pack publication all leave a Material's resolved lineage color
  unchanged — each has a dedicated test.

**Visual presentation:** a small colored dot (9px) before the material name,
on both Material cards and Family member rows. No card is filled with color,
no lifecycle button was recolored, no gradient or multi-lineage blending.

### Files added

`src/domain/alchemy/lineage.ts`, `tests/integration/lineage-color.test.ts`,
`tests/integration/material-playback-and-selection.test.ts`.

### Files modified

`src/web/lab.ts` (`lineageColor` method, `material()` extended to include
rejected), `web/app.js` (auto-switch on selection activation, unified player,
lineage dots, play buttons, hit-target separation), `web/index.html` (CSS for
dots, play buttons, pick-row layout).

### No canonical change

No structural primitive, no persistence field, no schema change, no ADR. The
existing `ancestors()` query and the existing content-addressed `ContentStore`
were sufficient for both features.

## Mesa V1 — dual-territory creative exploration

**Artist direction (feedback, not architecture):** move significantly away
from the source while the source stays an anchor, so different inputs never
collapse toward the same generic sound; 8 observations split 4 Medium / 4
Unexpected; Unexpected must use different deviation strategies, not just
different seeds; different Unexpected outputs should preserve different
inherited characteristics; no global Depth slider yet; physical listening
remains authoritative.

### MesaState

```
fragmentar: { escala, desorden }      // 0..100 each
acelerar:   { tiempo, movimiento }
microscopio:{ zoom, persistencia }
excitar:    { energia, estabilidad }
```

**Clamping rule:** every value is clamped into [0,100] and rounded, never
rejected — `validateMesaState` is total. Serialization
(`serializeMesaState`) is a plain deterministic join, used both for provenance
display and nowhere near seed derivation (seeds derive from baseSeed +
territory + strategy index, independent of the numeric slider values, so a
MesaState change and a seed change are two clearly separate inputs).

**Default**, chosen after generating the reference corpus below rather than
guessing: `escala 60, desorden 60, tiempo 55, movimiento 40, zoom 55,
persistencia 45, energia 40, estabilidad 55` — visibly transformed at rest,
without starting at the extremes.

### mesa-exploration-v1@1.0.0

A new, separate configuration. `fragment-exploration-v1` (1.0.0/1.1.0/1.2.0)
is untouched — verified against all three golden hash sets in the test suite.
New DSP primitives (`timeScaleFrames`, `excite`, `loopRegion`) were added to
`src/audio/operations.ts` additively; nothing already exported there was
modified. Mesa's render pipeline reuses, unmodified: `fragmentEvenly`,
`shuffleWithSeed`, `sliceFragment`, `reverseFrames`, `applyGain`,
`applyBoundaryFade`, `fadeFramesForSampleRate`, and the existing Preview-level
gain-consistency correction (`computePreviewGainCorrection`) from
fragment-exploration-v1 — the same ±4dB/65%-pull model, called directly
rather than reimplemented.

### MEDIUM vs UNEXPECTED

Not a depth metric with a threshold. MEDIUM strategies weight all four tools
below 1.0 (0.2–1.0), keeping every transformation inside a range where the
source stays evident. UNEXPECTED strategies weight one or two tools above 1.0
(up to 1.4), pushing a specific dimension hard while the others stay
moderate — and, critically, only Unexpected strategies carry a preservation
anchor. Medium strategies need none: staying close to source is their
default behavior by construction, not an explicit constraint.

**Four Medium strategies** (`medium-structure`, `medium-fragment`,
`medium-temporal`, `medium-texture`) — internal names, never shown to the
artist — each emphasize a different tool combination per the brief's
suggested profiles.

**Four Unexpected strategies**, each with a distinct preservation anchor:

| Strategy | Emphasis | Anchor |
|---|---|---|
| `unexpected-temporal-deviation` | Acelerar | `transient-peak` |
| `unexpected-microscopic-deviation` | Microscopio | `texture-window` |
| `unexpected-energetic-deviation` | Excitar | `onset` |
| `unexpected-hybrid-deviation` | all four, elevated together | `fragment-identity` |

Hybrid is explicitly not "everything at maximum" — its weights (0.9 across
all four tools) sit below several single-emphasis strategies' peak weight
(1.4), consistent with "interaction among tools," not brute intensity.

### Preservation anchor model

Four deterministic, measurable anchors — no perceptual AI, no embeddings:

- **`onset`** — the source's first ~50ms (capped at ⅛ of total length or 400
  frames) spliced in unmodified.
- **`texture-window`** — a source window centered at the temporal midpoint.
- **`transient-peak`** — a window centered on the source's single loudest
  frame (linear scan for maximum absolute sample, deterministic).
- **`fragment-identity`** — the second quarter of the source, verbatim,
  independent of the strategy's own fragment count — a stable, reproducible
  region regardless of Escala.

Each anchor is located in the **source**, before any transformation, then
prepended verbatim to the transformed output. This guarantees the named
characteristic survives regardless of how aggressively the rest of the
Mesa pipeline transforms the remainder — a structural guarantee, not a
statistical one.

### Excitation safety

`excite()` blends wet (waveshaped + seeded jitter) and dry signal by an
integer ratio; at `energia=100` at least 15% dry signal always survives
(`MIN_DRY_NUMERATOR = 15` of 100), so maximum Energía reads as stressed and
unstable rather than pure destruction. Verified: zero clipped samples across
every reference-corpus observation and every adversarial fixture tested
(silence, 64-frame minimum input, extreme MesaState).

### Seed derivation

```
baseSeed → territorySeed = baseSeed + (medium: 0 | unexpected: 500003)
         → strategySeed  = territorySeed + strategyIndex × 104729
         → operationSeed = strategySeed + operationTag × 40009
```

Both offsets are primes, chosen only to spread values apart with no other
significance. Documented and tested directly (`deriveStrategySeed`), not just
asserted through output hashes.

### Cross-source collapse prevention

Because each strategy's preservation anchor is located *in that source's own
audio*, two different sources can never produce identical Unexpected output
under identical MesaState and seed — the anchor content alone differs.
Verified with two unrelated fixture sources at both the default MesaState and
an all-controls-at-100 extreme: 0 of 8 collapsed pairs in both cases.

### Reference corpus

Three fixture characters (percussive/transient, sustained/tonal, noisy),
default MesaState, base seed 1000: 8/8 unique hashes per source, zero
clipping, 31–80ms generation time for all eight observations — well inside
the "part of an exploratory gesture" target. No workers were needed; measured
before considering them, per the brief.

### Provenance

Nothing new persisted structurally. A Mesa run creates one Experiment Entity
exactly as fragment-exploration-v1 does (`operation: 'exploration'`,
`configurationId: 'mesa-exploration-v1'`). Retain writes the complete
MesaState, territory, strategy id and anchor into the retained Material's
`attributes.parameters` — no code change to `retain()` itself was needed,
since `preview.parameters` already copies onto the Material verbatim.
Second-generation exploration and lineage-color-root resolution were verified
directly: A → B (Unexpected) → C (Medium), genealogy resolves A→B→C, lineage
color still resolves to the original root A.

### Files added

`src/domain/alchemy/mesa.ts`, `tests/integration/mesa.test.ts`.

### Files modified

`src/audio/operations.ts` (additive: `timeScaleFrames`, `excite`,
`loopRegion`), `src/domain/alchemy/service.ts` (additive:
`runMesaExploration` method, `MesaPreviewSet`/`MesaPreviewVariation` types),
`src/web/lab.ts` (`exploreMesa`, `defaultMesaState`), `web/index.html` (Mesa
panel: mode tabs, eight sliders, grouped results markup and styles),
`web/app.js` (slider reading, Mesa exploration call, grouped Medium/Unexpected
rendering, play/retain/discard reusing the existing single-player
infrastructure).

### No Method yet

MesaState is a clean, self-contained, serializable object specifically so a
future "Save as Method" only needs to persist this shape — no Save button, no
Method vocabulary, no persistence path was added in this phase.

## Mesa V1 not approved — physical feedback and two fixes

**Physical artist feedback, verbatim classification per the Canon's own
distinction (measured evidence stays separate below):**

1. The eight outputs did not sound perceptually distinct enough. Hashes and
   seeds differed but that does not guarantee audible difference. Revised
   criterion: 4 Medium clearly different from source but still recognizable;
   4 Unexpected clearly different **from each other**, not only from source,
   each with one dominant perceptible transformation (temporal
   stretch/compress/discontinuity, microscopic extraction/repetition,
   energetic saturation/instability, hybrid as genuine structural
   recombination — not "everything moderate").
2. A JavaScript error, `unsupported key component type: undefined`, appeared
   as a toast after generating variations, on the real device.

**Mesa V1 is not approved.** Both are addressed below; physical listening
remains the final judge, not this document.

### Bug: `unsupported key component type: undefined`

**Root cause.** `encodeKey` in `src/persistence/keys.ts` threw on any
component that was literally `undefined`, while the adapters' own field
extraction (`#extract`) already normalizes a missing field to `null` before
it reaches an index entry. That asymmetry meant only a RAW, hand-assembled
query tuple — a keyset pagination cursor, an adjacency query's optional
`type` filter — could ever trigger it, and only on a store carrying older or
unusual record shapes; it did not reproduce in this environment against
freshly-created data through either the SQLite or IndexedDB adapter, only
against inputs deliberately constructed to be missing a field. That is
consistent with the toast appearing on a real device with weeks of
accumulated history across many prior builds, rather than in a fresh test
fixture.

**Fix.** `encodeKey` now treats `undefined` identically to `null` — the same
degrade-gracefully rule the extraction layer already followed, applied
consistently at the one place that had been missing it. This is a narrowing
of failure modes, not a semantic change: `undefined` and `null` were already
indistinguishable everywhere the encoding is consumed.

**Defense in depth.** Independent of root cause, `renderMaterials()` and
`renderFamilyDetail()` computed lineage color for every visible Material via
one `Promise.all` — a single resolution failure aborted the whole render and,
worse, surfaced through `keepPreview`'s catch block as a raw error toast
covering the just-retained result. Lineage color is a recognition aid, not a
requirement; resolving it for one Material must never block seeing or
retaining any other. Both call sites now use a `safeLineageColor` wrapper
that falls back to a neutral marker per-Material on failure instead of
failing the whole list.

### Mesa perceptual distance

**Measured evidence, reference corpus before the fix:** all eight
observations converged to RMS 0.106–0.131 and peak 0.29–0.37 regardless of
strategy — a narrow band that matches the artist's complaint almost exactly.

**Root cause, found by direct measurement, not guessed:** Mesa's final gain
stage reused fragment-exploration-v1's Preview-level correction unchanged —
which pulls every variation 65% of the way toward one shared RMS target.
That is exactly right for fragment-exploration-v1, where variations are
meant to sound comparably loud. It is exactly wrong for Mesa, where
Energética is *supposed* to read louder and harsher than Microscópica — the
correction was actively erasing the contrast between territories that Mesa
exists to produce.

**Fix 1 — gain stage.** Mesa's final step is now peak-only safety: reduce
gain only if the transformation pushed the signal past the clipping
ceiling, never pull toward a shared loudness target. Zero clipping confirmed
on the reference corpus, spread widened from ~0dB effective (all outputs
statistically indistinguishable) toward each strategy's natural energy
profile.

**Fix 2 — dominant treatment per Unexpected strategy.** Weight multipliers
alone produced outputs that differed in seed and detail but not in kind — the
artist's core objection. Each Unexpected strategy now forces one unmistakable
structural behavior, added as a `dominantTreatment` on `MesaStrategy`,
layered on top of (not replacing) the existing weight-based translation:

- **`temporal-alternation`** (unexpected-temporal-deviation): fragments
  alternate between hard compression and hard stretch by position parity,
  rather than gentle continuous jitter around one ratio — audible
  discontinuity at every cut, matching "stretch/compress, repetición,
  discontinuidad temporal" directly.
- **`microscopic-lock`** (unexpected-microscopic-deviation): forces a small
  region (≤64 frames) and 5–8 repeats regardless of the Zoom/Persistencia
  sliders, so the granular/looping identity is never diluted by a mild
  MesaState.
- **`energetic-surge`** (unexpected-energetic-deviation): forces
  intensity/instability to a floor (75/70 of 100) regardless of the sliders,
  and skips the shared per-position gain decay so it stays loud throughout —
  the dry-floor safety inside `excite()` still guarantees it never fully
  destroys the signal.
- **`rotating-hybrid`** (unexpected-hybrid-deviation): rotates through all
  three dominant treatments **per fragment** by position (mod 3), producing
  genuine structural recombination rather than one moderate blend applied
  everywhere.

**Reference corpus after both fixes**, same synthetic source, base seed 1000:

| Strategy | Frames | Peak | RMS |
|---|---|---|---|
| medium-structure | 9548 | 0.499 | 0.159 |
| medium-fragment | 11808 | 0.497 | 0.150 |
| medium-temporal | 7812 | 0.500 | 0.186 |
| medium-texture | 6024 | 0.512 | 0.200 |
| unexpected-temporal-deviation | 4580 | 0.561 | 0.204 |
| unexpected-microscopic-deviation | 2048 | 0.404 | 0.170 |
| unexpected-energetic-deviation | 7812 | 0.561 | 0.226 |
| unexpected-hybrid-deviation | 6900 | 0.445 | 0.156 |

Duration alone now ranges 2048–11808 frames (≈5.8×) instead of clustering as
before; Energética has the highest RMS of the Unexpected set, consistent with
reading louder/harsher; zero clipping across the corpus; 0/8 collapsed pairs
against an unrelated second source, confirmed again after the change. All
211 tests remain green — none of Mesa's existing tests hash-lock specific
strategy output, so revising the DSP in place required no test rewrites,
only new evidence.

**Versioning decision, documented as asked:** revised `mesa-exploration-v1`
in place rather than publishing `1.1.0`. The prior version was explicitly
rejected before any physical Retain succeeded against it — no manifest exists
that could reference the earlier behavior, so the "never mutate a version
once used" rule that governs fragment-exploration-v1 does not yet apply here.
The moment a Mesa observation is retained and approved, this same discipline
switches on for Mesa too.

**Still not approved.** These are structural, measured improvements. Whether
they read correctly on the device — whether Energética actually sounds
louder and rougher, whether Microscópica actually sounds granular rather than
just shorter — is exactly what the next physical listening pass needs to
confirm.

## Mesa UI completion + non-colliding lineage colors

### UX defect — root cause found, and it was mine

**The Mesa UI was not missing. It was unreachable.**

`wire()` contained two `role="tab"` wiring loops. The mode tabs (Rápida/Mesa)
were wired first with a scoped selector; the Materials tabs were wired second
with an **unscoped** `document.querySelectorAll('[role=tab]')`. That second
selector also matched the mode tabs, and running later, silently overwrote
their handlers.

So tapping "Mesa" ran the Materials tab handler instead: it set
`state.tab = tab.dataset.tab`, which is `undefined` for a mode tab (mode tabs
carry `data-mode`), then re-rendered the Materials list. The Mesa panel was
never revealed, and the previous exploration UI stayed on screen — exactly
what the device showed.

**The same collision caused the other reported bug.** `state.tab = undefined`
flowed into `materialsByLifecycle(undefined)` → index prefix
`[role, undefined]` → `encodeKey` → `unsupported key component type:
undefined`. Both physical findings had one cause.

**This means the previous session's fix treated a symptom.** Making
`encodeKey` tolerate `undefined` was correct on its own terms — the extraction
layer already normalized missing fields to `null`, so the asymmetry was a real
latent defect worth closing — but it silenced the error message that was
pointing at the actual bug, and I concluded the cause was stale device data
without ever finding the code path that produced the `undefined`. The
diagnostic lesson is specific: an error whose *value* is `undefined` almost
always means a variable was never assigned, not that stored data is malformed.
I reached for the data explanation because I had recently been working on
storage, and stopped once the symptom disappeared.

**Fix.** Both wiring loops are now scoped — `#material-tabs [role=tab]` and
`#explore-mode-tabs [role=tab]`. A test asserts no unscoped `[role=tab]`
selector may reappear.

### Mesa UI completion

Eight sliders bound one-to-one to `MesaState` fields, verified by exercising
the real read/write functions: moving each control changes exactly its own
field and disturbs none of the other seven. Defaults come from
`lab.defaultMesaState` through the existing `openLab()` boundary — one source
of truth, no numbers duplicated in markup (asserted by test). **Restablecer
Mesa** re-applies the same domain defaults; runtime only, no Entity, no
Transition.

Results now group by each observation's **actual runtime territory metadata**,
not list position, and each observation displays its **real strategy
identity** — Estructura / Fragmentación / Temporal / Textura, and Temporal /
Microscópica / Energética / Híbrida — via `mesa-labels.ts`, which maps
identifiers to Spanish labels and fails loudly (`missingStrategyLabels()`) if
a strategy ever lacks one. No Mesa result is shown as "Variación N".

### Visual-semantics defect — lineage color collisions

**Previous algorithm:** `hash(rootId) % palette.length`. Two unrelated roots
could land on the same slot while other slots sat unused, visually implying
ancestry that does not exist — which is precisely the one thing the color is
supposed to communicate.

**New algorithm:** a browser-local registry. Resolve the root, look it up; if
unseen, take the first *free* slot, searching from the hash position (so
installs spread across the palette rather than all filling slot 0 first), then
persist. An already-assigned root **never** changes slot, so adding roots can
only consume free capacity, never reshuffle existing colors. Measured: ten
unrelated roots now occupy all ten slots with zero collisions.

**Palette exhaustion:** once every slot is assigned, a new root falls back
deterministically to its hash position. A collision becomes unavoidable at
that point, but it is reproducible and no existing root is disturbed to make
room — stability of what the artist already knows outweighs perfect
uniqueness.

**Storage boundary, explicit:** `localStorage`, key
`alchemy.lineage-palette.v1`. Chosen over IndexedDB because the payload is a
handful of short string→int pairs and localStorage was materially simpler.
It is **not** canonical: it never touches RecordStore, adds no Entity
attribute, and losing it costs only the specific colors previously shown —
never a Material, never genealogy. Tests assert no canonical attribute
matching `/color|palette|slot|lineage/` exists and that the registry module
contains no persistence call in executable code.

**Migration of existing device data:** lazy and non-destructive. An existing
root gets a registry slot the first time it is rendered after the upgrade,
then keeps it. Roots that previously collided under hash-modulo are separated
into free slots as they are encountered — verified by a test that finds two
ids genuinely colliding under the old rule and confirms the registry assigns
them different slots. No canonical record is rewritten.

**Resilience preserved:** `safeLineageColor` still isolates failures per
Material, and the neutral fallback (`#8b8b96`) is deliberately outside the
palette, so a resolution failure can never be mistaken for a real lineage.

### One more false-positive test, worth naming

A new assertion checking "the registry never touches canonical persistence"
initially failed — because the module *documents its own boundary* by naming
`RecordStore` in a comment. Fourth instance of the same pattern (after SQL,
`Math.random`, and `global`). Structural tests that grep source must strip
comments and string literals first; the rule is now applied consistently
across all of them.

### Measured evidence

229/229 tests (211 → 229, 18 added). Deployable artifact verified to contain
`mesa-panel`, `mesa-reset`, `material-tabs` and all eight slider ids. Boot
probe against the built bundle with `Buffer` deleted and no `localStorage`
available: `openLab()` resolves, labels map correctly, and the registry
degrades to fresh assignment rather than crashing.

## Playback flicker, and Source Conditioning V1 (Gate + Filter)

### Playback flicker — root cause, then fixed

Instrumented the call rather than guessing: `togglePlayMaterial` →
`refreshPlaybackViews()` → `renderMaterials()` (or `renderFamilyDetail()`) →
full `innerHTML` replacement of the entire container, including a fresh
lineage-color round trip through IndexedDB for every visible card — all of
that, on every single Play tap, to flip one ▶/⏸ icon. That full-list rebuild
was the visible flash.

**Fix.** `updatePlayButtons()` updates only the specific play controls'
icon/active-state directly, with no re-render of anything else. Nothing else
— scroll position, Mesa sliders, selection mode, tabs, Family state, lineage
colors — is touched by a play/pause action, because nothing else runs.
`playMesaObservation`, which had the identical defect for Mesa results
(`renderMesaResults()` on every tap), was unified onto the same path rather
than patched separately, so there is one playback-icon-update mechanism, not
two.

### Source Conditioning V1

**Two deterministic, portable, click-safe modules**, additive in
`src/audio/operations.ts`:

- **`applyGate`** — not a hard cut. Computes RMS over 5ms windows, derives a
  raw target gain per window (1 above threshold, a floor of 0.12 below —
  attenuates, never silences), smooths the gain across windows with separate
  attack (fast, 0.6) and release (slow, 0.08) rates, then applies gain
  per-sample via linear interpolation between window centers so no sample
  sees a stepped discontinuity. Measured on a synthetic mixed fixture (quiet
  broadband noise + a loud foreground event): quiet-region RMS dropped
  ~85–90%, active-region RMS stayed at ~99% of original.
- **`highPassFilter`** — a deterministic one-pole (RC-style) high-pass,
  applied independently per channel so stereo balance is never disturbed.
  `cutoffHz ≤ 0` is a literal no-op. Measured on a synthetic
  rumble(40Hz)+useful-tone(800Hz) fixture: 200Hz selectively suppressed the
  rumble while leaving the useful band essentially untouched.

**Parameter mapping**, chosen from those measurements, not guessed: Umbral
0–100 → gate RMS threshold 0.01–0.12; Limpieza 0–100 → high-pass cutoff
0–200Hz (0 is a literal no-op, so Limpieza=0 with the module enabled reads
identically to disabled).

**Shared boundary, `src/domain/alchemy/conditioning.ts`.** `InputConditioningState`
(`gate: {enabled, threshold}`, `filter: {enabled, amount}`), both OFF by
default. `applyConditioning(bytes, state)` is the one function both
`runResearchConfiguration` and `runMesaExploration` call before rendering —
neither duplicates this DSP path. **Bypass invariant, verified literally**:
with both disabled, `applyConditioning` returns the exact same `Uint8Array`
reference passed in, not merely acoustically-equivalent bytes — confirmed
`fragment-exploration-v1@1.0.0`'s golden hash is unaffected.

**Persistence boundary, explicit.** Conditioning operates only on the
in-memory exploration input buffer. The canonical Material's stored bytes
are never reassigned — verified by re-fetching the source Material's content
by its original hash after conditioning ran and confirming it decodes to the
same hash. If nothing is ever Retained, no trace of conditioning exists
anywhere. When something *is* Retained, `conditioningId`, `conditioningVersion`,
the full `conditioningState`, and the resolved numeric parameters all land in
`attributes.parameters` through the same verbatim-copy mechanism established
for `fragment-exploration-v1` and Mesa — no change to `retain()` was needed.

**Independent of Mesa's versioning**, by design: `mesa-exploration-v1` remains
at its current revision; conditioning is `input-conditioning-v1@1.0.0`, a
separate, optional upstream stage. Mesa without conditioning is byte-identical
to before this feature existed.

**Test correction worth recording.** The first version of the "gate
transitions are smoothed" test used a fixture with an instantaneous
amplitude jump in the *source* signal (silence to full amplitude in one
sample) and measured raw output-sample deltas — which meant the test was
partly measuring the source's own discontinuity, not the gate's behavior.
Rewritten twice: first to measure implied gain (output/input ratio) instead
of raw samples — which then produced a false failure of its own, from
dividing by near-zero samples at sine-wave zero-crossings, a numerically
unstable measurement unrelated to audio quality — and finally to sample one
comfortably-large peak per 5ms window and check gain continuity at the
window timescale, which is the actual timescale the smoothing algorithm
operates on and the property it actually guarantees.

**Measured evidence:** 251/251 tests (229→251, 22 added). Bypass path
confirmed via the existing `fragment-exploration-v1@1.0.0` golden hash.
Combined Gate+Filter deterministic together. Both Rápida and Mesa verified to
preserve their existing counts (8 variations; 4 Medium + 4 Unexpected) under
conditioning. Family/DNA Pack behavior unaffected. Zero clipping across every
fixture tested.

### Files added

`src/domain/alchemy/conditioning.ts`, `tests/integration/conditioning.test.ts`.

### Files modified

`src/audio/operations.ts` (additive: `applyGate`, `highPassFilter`),
`src/domain/alchemy/service.ts` (`runResearchConfiguration` and
`runMesaExploration` both gain an optional `conditioning` parameter, applied
before rendering; both preserve full backward compatibility when omitted),
`src/web/lab.ts` (`defaultConditioningState`, conditioning threaded through
`explore`/`exploreMesa`), `web/app.js` (playback flicker fix; Fuente panel
reads Gate/Filter controls), `web/index.html` (Fuente panel: two toggles, two
sliders, shared above both Rápida and Mesa).
