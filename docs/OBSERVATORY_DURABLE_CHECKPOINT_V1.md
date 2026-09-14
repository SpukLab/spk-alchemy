# Observatory Durable Checkpoint v1

This vertical slice validates that ForgeWorks Observatory research can be represented on the existing shared Knowledge Graph substrate without introducing new structural primitives.

## Scope

- FKC-000 remains unchanged.
- The five existing structural primitives remain unchanged: Entity, Relationship, Knowledge, Transition, Agent.
- Observatory adds only domain vocabulary and a durable historical checkpoint.
- EXP-2026-007 through EXP-2026-014 are reconstructed from preserved historical syntheses.
- EXP-2026-015 is recorded as ACTIVE and intentionally has no synthesis yet.

## Provenance rule

Historical reconstruction is not equivalent to possession of the complete primary evidence corpus. Each reconstructed Experiment carries `evidenceCompleteness`; EXP-007 through EXP-012 are explicitly `partial`, while EXP-013 through EXP-015 are `substantial`. No reconstructed record is promoted to epistemic `canon`.

## Constitutional baseline

- FKC-000
- version: 0.2
- status: CANDIDATE
- blob SHA: `d7fa6ff077b8d07aadb5f295d737f52d75d22dba`

## Files

- `src/domain/observatory/vocabulary.ts` — Observatory domain vocabulary over the shared substrate.
- `src/domain/observatory/checkpoint-v1.ts` — durable reconstructed research state.
- `src/domain/observatory/persist.ts` — bounded persistence of the checkpoint through `RecordStore`.
- `tests/architecture/observatory-durable-checkpoint.test.ts` — architecture invariants for the checkpoint.

## Authority boundary

This checkpoint is research evidence and operational continuity state. Committing it to GitHub does not make any finding Governance Canon or Epistemic Canon. Promotion remains governed separately by the Governance Canon.
