# Persistence, portability and query model — project implementation reference

**Normative authority:** `SpukLab/spuklab-canon`, `05-decisions/ADR-009-Persistence-Portability-and-Query-Model.md`

**Status of this document:** project-level implementation reference. It is **not** a normative Architectural Decision Record and claims no independent architectural authority.

The cross-domain decision is recorded in the Governance Canon as **ADR-009**. This file documents how that decision was realised in the Spk_Alchemy vertical slice. Where the two disagree, ADR-009 governs; the disagreement is a defect in this file.

Note on the previous filename: this document was drafted during the foundation review as "ADR-008" under conversational numbering. The Canon uses its own continuous documentary sequence, in which this decision is ADR-009. The filename is retained to preserve commit history; the identifier above is authoritative.

Note on `canon`: every occurrence of `canon` in this repository — in queries, stages and tests — refers to the **Epistemic Canon**, the Knowledge Graph epistemic stage. It never refers to the Governance Canon repository.

## Context

The canonical core must run today on Node and later in a browser without
changes to schemas, domain semantics, provenance, genealogy, promotion,
Research Intent, Agent attribution or query semantics. SQLite-class storage and
IndexedDB differ sharply in capability. Portability designed against the more
capable engine is portability that fails on first contact with the other.

## Decision

### D-1 — Model against IndexedDB, not SQL

The persistence data model is collections with a primary key plus declared
secondary indexes. No tables, joins, WHERE clauses, recursion or engine
transaction objects appear in the portable contract. SQLite *implements* this
model; it does not define it.

### D-2 — Two stores, split by nature of the data

`RecordStore` holds canonical records: indexed, paginable, transactionally
bounded. `ContentStore` holds audio bytes addressed by content hash: idempotent
`put`/`get`/`has`/`stat`, no indexes, no transactions.

They cannot share one portable transaction, so ordering is the guarantee:
content is written and verified **before** the record batch is committed. An
abandoned Retain therefore leaves an unreferenced, collectable blob — never a
record pointing at absent content.

### D-3 — Canonical key encoding (version 1)

Index keys are tuples of typed components with an order-preserving binary
encoding.

- Type tags fix cross-type order: `null < false < true < integer < string`.
- Integers: 8-byte big-endian offset binary, so signed order survives unsigned
  bytewise comparison. Non-integer numbers are rejected: timestamps must be
  numeric epoch milliseconds, never locale-dependent strings.
- Strings: UTF-8 with `0x00` escaped as `0x00 0xFF`, terminated by `0x00 0x00`.
  The terminator sorts below any escaped NUL, so `"" < "\0"` and `"a" < "ab"`.
- Compound keys concatenate self-delimiting components, so the encoding of the
  first *n* components is a byte prefix of every longer key. Prefix lookup is
  therefore a range over `[prefix, successor(prefix))`.

SQLite compares BLOBs with memcmp and IndexedDB compares binary keys bytewise,
so both engines produce identical ordering. Engine-native mixed-type ordering is
never relied on. The encoding is versioned; changing it requires a migration.

### D-4 — Index declarations are portable, index representation is not

Migrations declare indexes. The domain submits only semantic record mutations
(`put` / `delete`). Each adapter maintains its own index representation
atomically inside its own transaction: SQLite uses internal index-entry rows,
IndexedDB will use native object-store indexes. Index entries never appear in
the portable contract.

A consequence, recorded explicitly: to retire obsolete index entries on update,
the SQLite adapter reads the prior record inside its own bounded transaction.
That is adapter behaviour, fully determined before commit, and not domain logic.

### D-5 — One bounded atomic write primitive

There is no open, interactive or long-lived transaction. The only write is
`commit(batch)` over a fully precomputed, bounded (≤512) set of mutations.

Required pattern: read outside the transaction → decide in the domain →
prepare the complete batch → commit atomically → re-read if confirmation is
needed. Multi-record operations such as Retain are atomic because the entire
batch is prepared first, not because a transaction is held open.

### D-6 — Keyset pagination

The continuation value is the last canonical ordering tuple already observed —
not an engine cursor handle. Because every traversal index ends with the record
ID, the pagination key is unique, so over a stable store every record is
returned exactly once. Snapshot isolation across concurrent writes is **not**
promised by the portable contract; the first slice is local and single-user.

### D-7 — Default canonical order

`createdAt ASC, id ASC`, with the ID as mandatory tie-breaker, on every
traversal index. Where order is not semantically meaningful, results are treated
as sets and normalized before comparison. Every required query declares which
of the two applies.

### D-8 — Engine-independent traversal

Genealogy is iterative BFS in the query layer over indexed adjacency reads
(`adjacencyBySource` / `adjacencyByTarget`), with a visited set, cycle
detection, optional depth limit, page-bounded memory and continuation state.
No recursive CTEs, no graph-engine traversal, no stored procedures.

### D-9 — SQLite adapter uses a generic representation

Two internal tables (`records`, `index_entries`) rather than per-type tables
with native indexes. This costs idiomatic SQL and buys exact semantic parity
with IndexedDB: identical ordering, prefix, range and pagination behaviour, so
the conformance suite is meaningful rather than decorative.

## Alternatives rejected

- **Graph database.** None runs in a browser; "the product is called a graph"
  is not an engineering argument.
- **SQLite with generated columns and native indexes.** More idiomatic, but
  ordering and prefix semantics diverge from IndexedDB exactly where it matters.
- **Relational schema per type.** Unportable and it would leak SQL into the core.

## Conformance

One parameterized suite (`tests/conformance/suite.ts`) runs against any adapter
and asserts observable behaviour only, never internal index representation. It
includes adversarial key cases — empty components, prefix-like strings, embedded
NUL and control bytes, characters outside the BMP, negative integers, identical
timestamps resolved by ID — because those are what actually distinguish a
portable encoding from one that merely claims to be.

## Consequences

- The SQLite adapter maintains indexes by hand: more code, more tests, real parity.
- No known interactive query requires a full scan. The integrity audit does, and
  is declared as the single deliberate exception, paginated and off the
  interactive path.
- A future IndexedDB adapter implements the same interface and runs the same
  suite; nothing above it changes.
