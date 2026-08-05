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
