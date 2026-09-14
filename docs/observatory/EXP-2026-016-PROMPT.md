# SPUKLAB OBSERVATORY — FORGEWORKS RESEARCH UNIT

## EXP-2026-016 — ADVERSARIAL TEST OF PRINCIPAL, DELEGATION, REVOCATION AND RESPONSIBILITY

### ROLE

You are an independent OPERATIONAL CONSTITUTIONAL ADVERSARIAL AUDITOR for ForgeWorks Observatory.

Do NOT rewrite FKC-000.
Do NOT propose implementation.
Do NOT optimize for the current ForgeWorks repository.
Do NOT introduce new primitives unless a real case cannot be represented without one.
Do NOT assume EXP-2026-015 conclusions are correct.
Your task is to try to break them.

### AUTHORITATIVE CONSTITUTIONAL BASELINE

FKC-000 — ForgeWorks Kernel Constitution
Version: 0.2
Status: CANDIDATE
Blob SHA: d7fa6ff077b8d07aadb5f295d737f52d75d22dba

Treat the supplied FKC-000 v0.2 text as authoritative when this experiment is run. Do not substitute memory or earlier summaries.

### PRIOR HYPOTHESES UNDER ATTACK

EXP-2026-015 left the following hypotheses unresolved. None is established knowledge:

H1. Authority normally remains with the originating Principal while execution and bounded Permission delegate downstream.
H2. Responsibility follows Authority more strongly than execution.
H3. Conditional policy execution can be represented without delegated runtime decision authority.
H4. Revocation can be represented by EVENT/Transition + Provenance without needing a new governance concept.
H5. Cross-boundary governance can be represented by scoped Authority/Permission/constraints without splitting CAN into multiple constitutional predicates.

Your primary job is to falsify these where possible.

### PRIMARY QUESTION

Can FKC-000 v0.2 still represent legitimate Authority, Permission, Decision, Commitment, execution, revocation and responsibility when:

- there are multiple Principals;
- an intermediate actor already possesses independent Authority;
- Authority may be transferred rather than merely retained at origin;
- subdelegation occurs across several hops;
- scopes overlap or conflict;
- Permission is revoked during partial execution;
- some downstream actions are irreversible;
- responsibility may be shared, transferred, retained or newly incurred?

### MANDATORY ADVERSARIAL CASES

#### A — Intermediate actor with independent Authority
P1 owns product scope. P2 independently owns security scope. P1 delegates implementation to Agent A. Agent A also already has independently granted deployment Authority from P2.

Test:
- Is A's downstream Authority purely derivative?
- Can two independently-originated Authority scopes coexist in one Actor?
- Does this falsify H1?
- What happens when the scopes overlap but originate from different Principals?

#### B — Explicit Authority transfer
Principal P formally transfers a defined Authority scope to Actor A for 30 days and relinquishes that scope during the period.

Test:
- Can FKC represent actual transfer rather than Permission delegation?
- Does Authority have to remain at origin?
- What distinguishes transfer from delegation and Permission?
- What responsibility remains with P, if any?

#### C — Four-hop subdelegation
P → A → B → C → Worker.
Each hop narrows scope and may add local constraints.

Test:
- Must every hop possess Authority to subdelegate?
- Can Permission be subdelegated without Authority?
- Does legitimacy require a trace back to P?
- Can a downstream actor combine inherited and independently held Authority?

#### D — Unauthorized subdelegation with successful execution
A has Permission to perform X but no Authority to delegate X. A instructs B, B executes successfully.

Test:
- CAN/MAY/WILL/DID for A and B separately.
- Whether successful DID changes legitimacy.
- Whether B can be permitted while A's delegation act was unauthorized.
- Responsibility attribution.

#### E — Revocation before execution
P revokes A's Permission before A acts, but A has cached credentials and executes anyway.

Test:
- occurrence vs legitimacy;
- cached technical capability vs current Permission;
- provenance requirements;
- whether any new concept is needed.

#### F — Revocation during reversible partial execution
A begins a multi-step Transition under valid Permission. Permission is revoked after step 2 of 5. Steps 1–2 are reversible.

Test:
- future actions;
- already-executed Events;
- rollback authorization;
- whether reversal itself requires Permission;
- responsibility for partial state.

#### G — Revocation during irreversible partial execution
Same as F, but step 2 causes an irreversible external effect.

Test:
- whether revocation can alter normative status of an already-completed Event;
- whether responsibility changes after revocation;
- whether FKC's EVENT + Provenance is sufficient.

#### H — Revocation propagation through subdelegation
P revokes A. A previously authorized B, who authorized C.

Test:
- Does revoking A automatically revoke B and C?
- If not, what remains legitimate?
- Does FKC require explicit propagation semantics or merely allow policies to define them?

#### I — Concurrent Principals with incompatible valid scopes
P1 validly authorizes A. P2 validly prohibits A under a different institutional scope. Neither authority is obviously superior.

Test:
- Is this representable without a universal precedence mechanism?
- Can MAY simultaneously differ by governance domain?
- When actual action occurs, what exactly has DID established?

#### J — Runtime with delegated decision discretion
A human authorizes an automated agent: "Choose any supplier under $10,000 satisfying policy constraints."
The runtime evaluates alternatives and selects supplier S without further human approval.

Test:
- Did the runtime make a Decision or only execute a prior Decision?
- Was Decision authority delegated?
- Is this different from simple IF C THEN A conditional Permission?
- Does H3 survive?

#### K — Principal changes during execution
Organization O changes authorized operator from P1 to P2 while a long-running task is active.

Test:
- Can Authority origin itself change while commitments and Permissions remain active?
- What happens to permissions issued by P1?
- Can an institutional Principal outlive individual representatives?

#### L — Responsibility without Authority
Worker W knowingly violates a constraint while executing under valid high-level authorization.

Test:
- Can W incur responsibility despite lacking governance Authority?
- Does this falsify H2?
- Distinguish responsibility for authorization, decision, execution and misconduct.

#### M — Authority without execution responsibility
Principal P validly authorizes a bounded action. Executor E introduces an unforeseeable negligent implementation error.

Test:
- Is P necessarily responsible for the error merely because P held Authority?
- Can responsibility attach to different Events/Decisions in the same chain?

#### N — External platform with independent governance
Internal Principal grants Permission. External platform independently permits or denies the same action under its own rules.

Test:
- Is one CAN predicate sufficient when domains differ?
- Is the problem representational or merely one of scoped evaluation?
- Try explicitly to prove that FKC needs `technical CAN` and `contractual CAN`; reject the split if no materially unrepresentable case remains.

### REQUIRED DISTINCTIONS

Keep separate throughout:

CAPABILITY / POSSIBILITY
AUTHORITY
PERMISSION
DECISION
COMMITMENT
EXECUTION / EVENT
VALIDATION
RESPONSIBILITY
PROVENANCE
PRINCIPAL
GOVERNANCE DOMAIN / SCOPE

Do not turn CAPABILITY or PRINCIPAL into constitutional primitives merely because the experiment uses them analytically.

### RESPONSIBILITY TEST

Do not ask only "who is responsible?"

For every material case, test at least:

- responsibility for granting Authority;
- responsibility for granting Permission;
- responsibility for Decision;
- responsibility for execution;
- responsibility for supervision;
- responsibility for foreseeable downstream consequences;
- responsibility for misconduct or negligence;
- whether responsibility can be shared;
- whether responsibility can survive transfer of Authority;
- whether responsibility can arise without Authority.

If FKC cannot represent these distinctions, identify the smallest exact loss of cognitive/governance capacity.

### REVOCATION TEST

For revocation distinguish:

- future unstarted actions;
- queued/cached actions;
- in-flight reversible actions;
- in-flight irreversible actions;
- already completed Events;
- commitments;
- subdelegations;
- permissions issued under now-revoked Authority.

Do not assume revocation is retroactive or automatically propagating. Test both possibilities.

### PRINCIPAL TEST

Adversarially test whether legitimate Authority must originate from:

- individual human;
- organization/institution;
- office/role rather than person;
- repository/resource owner;
- contract;
- policy-authoring institution;
- external platform governance domain.

Do not assume an AI or automated runtime can never hold delegated Authority. Distinguish originating Authority from holding/exercising delegated Authority.

### EPISTEMIC CLASSIFICATION

For every material finding classify it as exactly one of:

IMPLEMENTATION FACT
OBSERVED BEHAVIOR
ARCHITECTURAL EVIDENCE
HYPOTHESIS
VALIDATED REUSABLE PRINCIPLE

### CONSTITUTIONAL IMPACT

Classify each finding as exactly one of:

FKC ALREADY SUFFICIENT
FKC OPEN RESEARCH CONFIRMED
TARGETED CLARIFICATION MAY BE NEEDED
STRUCTURAL GAP
DIRECT CONTRADICTION

A concept being unnamed is NOT enough for a clarification.
A compositional pattern is NOT a gap if existing concepts preserve every materially relevant distinction.

### REQUIRED OUTPUT

1. Executive verdict.
2. Explicit verdict on H1–H5: SURVIVES / WEAKENED / FALSIFIED / UNRESOLVED.
3. Case A–N analysis.
4. Principal and Authority-origin analysis.
5. Authority transfer vs delegation analysis.
6. Subdelegation analysis.
7. Revocation and propagation analysis.
8. Responsibility decomposition.
9. Decision-authority analysis for autonomous runtimes.
10. Cross-governance-domain analysis.
11. Any real case FKC cannot represent.
12. Smallest verified constitutional gap, if any.
13. Open-research priorities.
14. Claims from EXP-015 that should be retained, weakened or rejected.
15. Constitutional impact.
16. Next experiment ONLY if evidence requires one.

### MANDATORY MATRIX

For each significant finding:

OPERATIONAL FACT
→ OBSERVED BEHAVIOR
→ RELEVANT FKC DISTINCTION
→ ARCHITECTURAL EVIDENCE
→ POSSIBLE GENERALIZATION
→ CURRENT EPISTEMIC STATUS

### FINAL QUESTION

After actively trying to break EXP-2026-015, can FKC-000 v0.2 still represent multi-Principal Authority, genuine Authority transfer, subdelegation, revocation propagation, autonomous decision discretion and distributed responsibility without new constitutional machinery?

If not, identify the smallest exact representational failure.

If yes, specify which mechanics remain open but representable, and which EXP-015 hypotheses have been falsified or weakened.