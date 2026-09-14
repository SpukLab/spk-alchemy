# EXP-2026-015 — Operational Validation of Authority, Permission and Delegation

Status: CLOSED — SYNTHESIZED
Constitutional baseline: FKC-000 v0.2 CANDIDATE
Baseline blob SHA: d7fa6ff077b8d07aadb5f295d737f52d75d22dba
Evidence set: independent responses from Grok, DeepSeek, Claude and Gemini, plus Observatory synthesis.

## Executive verdict

FKC-000 v0.2 is sufficient to represent all tested A–L human–AI–software governance cases. No direct contradiction, primitive delta or structural representational gap was verified.

Operational testing materially strengthens the existing separations among possibility/capability, Authority, Permission, Decision, Commitment, occurrence/execution and Validation. It also confirms that delegation, revocation, concurrent authority, Principal/legitimacy and authority during partial execution are load-bearing open research rather than merely theoretical incompleteness.

One additional open-research topic is verified: responsibility transfer, sharing and retention across delegation chains. FKC protects a relationship between authority and responsibility through its invariants, but the supplied Section 19 text does not explicitly list responsibility-distribution mechanics. This is an open research delta, not a new primitive and not a contradiction.

No constitutional amendment is warranted by EXP-2026-015.

## Strong convergence

All four independent audits converge on:

- technical ability or credentials do not create legitimate Authority;
- Validation does not authorize execution;
- successful occurrence does not retroactively establish legitimacy;
- AI recommendation or confidence does not create Authority;
- provenance can preserve partial execution, revocation points and divergent histories;
- automated policy can be represented without making the runtime an originator of Authority;
- delegation, revocation and concurrent-authority mechanics remain open;
- no tested case requires a new structural primitive.

## Corrections to model overclaims

The synthesis does not adopt several stronger claims made by individual auditors.

1. `CAN` in FKC means "possible?". EXP-015 uses CAPABILITY as an operational analytic category, but does not establish CAPABILITY as a constitutional primitive or prove that CAPABILITY is definitionally identical to CAN. This matters especially at external-platform boundaries.
2. Responsibility distribution is not explicitly listed in the supplied Section 19 open-research list. Claims that it was already listed are rejected. EXP-015 adds it as a research candidate.
3. Evidence does not establish that delegation never transfers Authority or that ultimate responsibility always remains with the originating Principal. Those are hypotheses requiring adversarial testing.
4. Evidence does not establish that revocation always terminates every in-flight step or changes the normative status of already-executed steps. EVENT and Provenance preserve the history; consequence semantics remain open.
5. External platform refusal does not require splitting CAN into constitutional `technical CAN` and `contractual CAN`. Internal and external constraints can already be represented by scoped relations and provenance. The proposed split remains a hypothesis, not a targeted constitutional delta.
6. Conditional pre-authorization is representable as scoped/conditional Permission plus prior governance decision. Its lack of a dedicated name is not evidence of constitutional insufficiency.

## Case synthesis

### A — Technical capability
Credentials establish operational ability, not Authority. A scoped instruction may participate in a legitimate Permission grant only under the relevant Authority. Successful execution proves DID, not legitimacy.

### B — Delegated development
Human → coordinator → coding agent → API is representable without collapsing execution, Permission and Authority. What exactly transfers at each hop, how scope narrows, and whether Authority itself can be delegated are open mechanics.

### C — Validation versus authorization
`VALID = yes` and `MAY = no` is coherent. CI/test success is evidence relevant to judgment; it does not grant Permission.

### D — Remote checkpoint and recovery
Commit SHA, branch, PR and CI state provide externally verifiable occurrence/provenance. They do not by themselves establish Authority, Permission, Knowledge or Canon. This is architectural evidence supporting FKC provenance, not a new universal principle.

### E — Outbound governance
Infrastructure may be technically capable while governance withholds Permission. Repeated successful generation does not silently expand Authority.

### F — Read-only context
Read-only behavior may result from technical capability limits, Authority scope, Permission policy, or combinations. These must not be collapsed.

### G — Partial execution and revocation
FKC can represent partial execution and revocation through EVENT/Transition plus Provenance. The unresolved question is normative consequence: future steps, in-flight effects, subdelegations, cached grants and prior acts. Open research confirmed.

### H — Concurrent authority
Conflicting authority claims/scopes remain representable without forced resolution. Precedence, legitimacy and conflict-resolution mechanics remain open.

### I — Recommendation versus decision
AI recommendation/confidence is epistemic input, not Authority. Human/institutional governance can select a different action while preserving dissent and later evidence.

### J — Automated policy
A policy `IF C THEN A` can be represented as prior authorized governance plus conditional/scoped Permission and later execution when C is satisfied. Whether some systems instead delegate decision authority to a runtime is a separate hypothesis. No dedicated constitutional concept is currently required.

### K — External platform boundary
External platforms can impose independent constraints on actual execution. The case does not prove a constitutional ambiguity in CAN; it demonstrates the need to preserve governance domain/scope and provenance at boundaries.

### L — Responsibility
FKC distinguishes responsibility from mere execution, but does not specify how responsibility is retained, shared or transferred across delegation chains. This is the smallest new research delta exposed by EXP-015.

## Epistemic classification

### Operationally reinforced constitutional distinctions
- Belief/confidence does not create Authority.
- Permission does not silently generalize into Authority.
- Validation does not grant Permission.
- Occurrence does not prove legitimacy.
- Provenance preserves materially distinct histories.

### Architectural evidence
- Human–AI–software chains repeatedly require explicit separation of technical ability, Authority, Permission and execution.
- Delegation and revocation mechanics are operationally load-bearing.
- External durable provenance materially improves recovery from interrupted cognitive/implementation sessions.

### Hypotheses retained for future adversarial testing
- Authority normally remains at the originating Principal while execution and bounded Permission delegate downstream.
- Responsibility follows Authority more strongly than execution.
- Conditional policy execution can always be modeled without delegated runtime decision authority.
- Cross-boundary governance may benefit from a more explicit taxonomy of constraints, but no constitutional need is established.

### Rejected/promoted-no-further
- New primitive for delegation: rejected by current evidence.
- New primitive for responsibility: rejected by current evidence.
- Dedicated constitutional function for conditional pre-authorization: not warranted.
- Split CAN predicate: not warranted by current evidence.

## Constitutional impact

- FKC ALREADY SUFFICIENT: core representational grammar across Cases A–L.
- FKC OPEN RESEARCH CONFIRMED: delegation, revocation, expiry, concurrent authority, legitimacy, Principal, authority during partial execution.
- NEW OPEN-RESEARCH CANDIDATE: responsibility transfer/sharing/retention across delegation chains.
- TARGETED CLARIFICATION: none required now.
- STRUCTURAL GAP: none.
- DIRECT CONTRADICTION: none.
- PRIMITIVE DELTA: none.
- CONSTITUTIONAL AMENDMENT: none.

## Decision

EXP-2026-015 is closed as operational validation evidence. It does not amend FKC-000.

The next research should not reopen the full governance grammar. If continued, it should adversarially test the smallest unresolved cluster: Principal → delegation → revocation → responsibility, including an intermediate actor with independent pre-existing Authority, multi-hop subdelegation, concurrent scopes and revocation during partial execution.
