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
