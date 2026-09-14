# Observatory Delivery Incident — EXP-2026-016

Status: RECORDED OPERATIONAL EVIDENCE
Date: 2026-09-14

## Observation

The durable EXP-2026-016 protocol in `docs/observatory/EXP-2026-016-PROMPT.md` was complete, but the user-facing handoff exposed only its opening fragment. DeepSeek therefore received an incomplete experimental object and correctly halted instead of reconstructing missing targets from memory.

## Classification

IMPLEMENTATION / PROCESS FACT, not constitutional evidence.

This incident does not alter FKC-000 and does not count as evidence for or against H1–H5.

## Consequence

DeepSeek's halted response is excluded from the independent EXP-2026-016 evidence set. Its pre-registered adversarial targets may be retained as hypotheses for future analysis, but not as experiment results.

## Process lesson

A durable source of truth is insufficient if transport from that source to an external cognitive resource can silently truncate the research object.

For externally executed Observatory experiments, the handoff must preserve:

1. authoritative baseline identifier;
2. hypotheses under test;
3. mandatory cases;
4. classification rules;
5. required output;
6. final question;
7. explicit completeness marker.

Before treating an external response as evidence, Observatory should verify that the responder received the complete research object or that the response itself demonstrates awareness of all mandatory sections.

## Epistemic status

Observed operational failure. Possible reusable process rule, not yet generalized beyond this incident.
