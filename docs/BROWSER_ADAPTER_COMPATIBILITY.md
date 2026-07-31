# Browser adapter compatibility note

What a future IndexedDB `RecordStore` must implement, and what must **not**
change when it arrives.

## Must not change

- Canonical schemas and the five structural primitives.
- Canonical key encoding (version 1) and its ordering semantics.
- Query semantics, including declared canonical order and normalized-set rules.
- Lifecycle semantics: Preview, Discard, Retain, Promote, Reject.
- Provenance: every Observation, Knowledge record and Transition references an Agent.
- Genealogy: iterative adjacency traversal in the query layer.
- Transaction guarantees: one bounded, precomputed atomic batch.
- Material identity: UUID per occurrence, content hash separate, no merging.

If adding the browser adapter requires touching any of the above, the adapter is
wrong — or the portable contract was, and that is an architectural contradiction
to report rather than to work around.

## What the adapter must provide

| Capability | IndexedDB realisation |
|---|---|
| read by ID / bounded multi-read | `objectStore.get` over one transaction |
| semantic put / delete | `put` / `delete`, with index maintenance native |
| bounded atomic batch | one `readwrite` transaction, all mutations queued without intervening awaits |
| exact / compound / prefix / range lookup | `IDBKeyRange` over binary keys produced by the shared encoder |
| keyset pagination | `IDBKeyRange.lowerBound(encoded, /* open */ true)` |
| adjacency by source / target | prefix lookup on `rel_by_source` / `rel_by_target` |
| schema version | `meta` object store |
| typed integrity errors | map `ConstraintError` to `UniquenessError` |

## The two traps

**Transactions auto-close.** An IndexedDB transaction commits when the event
loop yields without pending requests. The portable contract already forbids
awaiting anything unrelated inside a batch, so the adapter must queue every
mutation of a batch synchronously and only then await completion. This is why
`commit(batch)` takes a fully precomputed array and never a callback.

**Keys must be binary, not native.** Use the shared encoder from
`src/persistence/keys.ts` and store `Uint8Array` keys. Do not use native
JavaScript values as IndexedDB keys: its mixed-type ordering rules differ from
SQLite's and the declared canonical order would silently diverge.

## Acceptance

The adapter is accepted when it passes `tests/conformance/suite.ts` unchanged —
including the adversarial key cases — and the architectural tests still pass with
the browser adapter substituted at the composition root in `src/cli/context.ts`.

## Content store

`ContentStore` will need its own browser implementation, most likely OPFS or
blobs in a dedicated object store. Only the four semantic capabilities matter:
idempotent `put` by hash, `get`, `has`, `stat`. The content-first write ordering
that keeps Retain safe is a domain rule and holds unchanged.
