# ADR 0053: Memory Agent test discipline — three-layer metrics, server-side evidence, delivery before gain

Status: accepted (design; the quality layer lands with this ADR, the value layer is a future benchmark)
Date: 2026-09-20 (design session: grill-with-docs, decisions Q1–Q8)

> Numbering note: `feat/group-memory` holds ADRs 0052–0055 on its branch; this
> ADR on main takes the number independently, renumbered at merge (same note
> as ADR 0052).

## Context

The Memory Agent subsystem (ADR 0052) needs tests beyond value semantics: does
it explore when probed, does retrieval find the right layers, do offers carry
the right content, and does the whole loop stay disciplined. Two bodies of
prior art shape the discipline:

- The local EvoAgentBench adaptation (bench-runner over pi-group-chat-host +
  GMS): paired warm/cold arms, transfer gain with bootstrap CI, and the
  hard-won rule that mechanism evidence must be measured orthogonally to task
  scores.
- The areal graph-memory-regression campaign: v1 scoring (task results only)
  reported 100% while mechanism evidence was near zero; the recall precision
  was 100% once measured — all losses were in execution rate; reply text
  proved unreliable as evidence in BOTH directions; a zero-gain run traced to
  a silently broken delivery channel that task scores could not see.

## Decision

**A. Test the memory quality first; the memory value later.** Phase 1 is the
quality layer: Memory Scenarios (marker-seeded teaching timelines) driven
through the real pipeline with fixture-controlled LLM output, asserting the
deterministic machinery — retrieval runs real trigram matching over
scenario-authored content; distillation content is fixture-controlled. The
value layer (paired on/off arms over a task suite, transfer gain, judge as
auxiliary only) is a separate future benchmark, not part of this suite.

**B. Three-layer metrics, never conflated.** Every probe measures:

1. **execution** — did the Memory Agent act at all (an exploration session exists
   for the probe);
2. **recall** — do the session's citations cover the expected targets
   (episode / insight head / skill head);
3. **precision** — does the served content carry the expected marker.

Execution loss is not a retrieval bug; recall loss is not a precision bug.
Areal's campaign showed conflating them hides the real failure layer.

**C. Evidence is the server's records, never the reply text.** Citations,
offer deliveries, score events, ledger entries — immutable rows. Model reply
text is at best corroboration. This is the coforge counterpart of the
`marker_in_start_nodes` discipline.

**D. Delivery before gain.** Any offer assertion first proves delivery (the
`memory_offer_deliveries` row plus the structured mention on the message),
then content. An offer that was never delivered cannot be explained away by
relevance judgments.

**E. Discipline probes are first-class.** Every scenario carries: a decoy
(human says "don't record this" — the pipeline may snapshot the episode
transcript, but the fact must never appear in an insight, skill, or offer);
a negative probe (never-taught topic — no offer, no marker-bearing citation);
cooldown assertions (the same target is not re-delivered inside the window;
explicit ask bypasses and is recorded as such).

**F. Zero LLM judges in the regression suite.** The quality layer runs with a
routing fake LLM through the real sweep path (same method as the existing 42
value tests). Anything needing judge judgment belongs to the value layer or
the manually gated real-model smoke.

**G. Two run levels.** Function-level scenarios run in the standard memory
suite. A protocol-level e2e drives the fenced tool wire (start → explore →
redirect → submit → offer) against the real HTTP boundary with a
protocol-faithful client; a manually gated full-stack smoke (real model, run
only after explicit confirmation) exercises the agent's own turn behavior.

## Rejected alternatives

- **LLM-judge in regression.** Non-deterministic, needs credentials, and
  historical evidence shows judges mask mechanism failures.
- **Reply text as recall evidence.** Discredited in both directions by the
  areal run-7 series.
- **Porting EvoAgentBench tasks for the quality layer.** Coforge's memory
  triggers on channel collaboration, not task trajectories; the port loses
  marker precision. The port belongs to the value layer if that layer is
  ever built on official tasks.
- **Task-score-only testing.** The areal v1 lesson: 100% task score with
  near-zero mechanism evidence.

## Consequences

- The Memory Agent gains an `offer` operation on its fenced HTTP boundary
  (wrapping `publishMemoryOffer`) — without it the disciplined offer path is
  unreachable from the agent's own tools, which this test design surfaced.
- `Memory Scenario` and `Memory Probe` enter the glossary as test-material
  terms, distinct from Memory Episode.
- The value layer (paired arms, transfer gain) is explicitly deferred, not
  denied; when built, it reports `system-comparison-only` numbers.

## Validation

Scenario tests assert all three metric layers plus every discipline probe
against the scratch database; the protocol e2e asserts fence, idempotency,
and the full tool chain over real HTTP; the manual smoke reuses the
scenario assertions against a real model run.

Live half record (decision G's full-stack smoke, 2026-09-21): the fenced
Memory Agent answered an explicit @-mention over the full dev stack (real
LLM, daemon host, local proxy, transport, web, Postgres) — message_check →
memory_start (a self-invented slug start key) → memory_explore from a
`skill:` anchor → memory_submit with citations → a cited channel answer;
exploration sessions recorded in the database and zero proxy failures.
That run was the live conviction for the memory wire's three contract gaps
(skill citations undecodable at the SDK codec, the operation-key slug
contract missing from the fenced tool schema and instructions, the
`offer` op missing at the daemon proxy, and the transport flattening the
server's errorCode) — fixed with layer-pinning tests in `c2cd4e5f`.
The triage method that convicted them — replaying the transport's exact
request shape (minted agent key + daemon key, camelCase command JSON)
directly at the live web route — remains the fastest loop for any future
memory-wire regression.
