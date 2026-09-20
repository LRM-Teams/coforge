# ADR 0052: LearnedSkill evolution loop — standalone Group Memory substrate on main

Status: accepted (implemented — slices 1–6 landed 2026-09-20; the real-LLM smoke (slice 6) runs via `mise run test:e2e:group-memory` and skips cleanly without credentials)
Date: 2026-09-20 (design session: grill-with-docs, decisions Q1–Q13)

> Numbering note: `feat/group-memory` holds ADRs 0052–0055 for the Group Memory
> branch. This ADR on main takes the number independently; renumber at merge.

## Context

CoForge implements the skill-evolution method of the WikiSkill paper (Tang et al.,
arXiv 2608.27454 — cited only as the source method, never a CoForge identifier):
a closed loop in which team experience is distilled into a persistent knowledge
layer and compiled, proposal by proposal, into governed evolving skills — here the
**LearnedSkill** flow the glossary reserves as the procedural descendant of memory.

Three references, each absorbed at a different depth:

1. **`feat/group-memory` branch** (CoForge's own Group Memory work): port proven
   pieces — interaction-link extraction, the distillation worker shape, the
   bounded exploration protocol, the fenced memory-agent runtime profile, offer
   discipline. Reuse its vocabulary one-to-one.
2. **`river2_0/memory_graph_evolving/graph-memory-service`** (reference stack):
   the `skill-artifact/2.0` governed artifact model — immutable revisions
   identified by lineage/version/digest, evidence references throughout, a closed
   set of artifact kinds, proposal→candidate→activation governance shape.
3. **The WikiSkill paper**: the loop cadence — one atomic proposal per iteration,
   failure-first stratified evidence sampling, and the never-rollback proposal
   audit ledger (its `skill-impact.md`).

The design session settled thirteen decisions (Q1–Q13); the load-bearing ones
follow.

## Decision

**A. Standalone on main, concept-aligned with `feat/group-memory` (Q1).** The
loop is implemented on `main` without depending on the Group Memory branch, but
reuses its vocabulary one-to-one (Group Memory, Memory Episode, Memory Insight,
Interaction Links, Memory Agent, Memory Exploration, Memory Offer) so a later
merge is terminological, not conceptual. The merge story with the branch is
deferred, not denied.

**B. The full loop, four roles mapped (Q2).** Raw experience = the interaction
record; the paper's Wiki-Maintainer role = the server-side distillation worker;
the Skill-Proposer role = a server-side worker LLM (Q11); the Gate = shadow
gating (D); the skill layer = LearnedSkill artifacts (F).

**C. Raw layer: message-level interaction DAG, content by reference (Q3, Q6).**
Segments are `AgentMessageDelivery` rows (one agent handling one delivery); nodes
are PublicChannel messages; edges are Interaction Links (`mentions`,
`responds_to`, `delegates_to`) extracted losslessly at ingestion from structured
facts only — ported from the branch's `memory-interactions` implementation.
Message bodies are referenced, not copied into the layer; consumers expand them
on demand. Memory Episodes are admitted windows over this record (Task-completion
and quiet-window triggers) with participants snapshots and inferred outcomes.
Tool-level execution-event capture (the reference stack's frozen segment DAG of
`tool_call`/`tool_result` events) is a deliberate future slice with its own ADR —
it requires a new daemon telemetry boundary that does not exist on main.

**D. Shadow gating, not validation-split gating (Q7).** A product environment
has no grader and no held-out task split, so the paper's strict-improvement
validation gate cannot be transplanted. Instead: a Skill Proposal enters a
**candidate** state; the Memory Agent delivers skill-backed Memory Offers; real
collaboration outcomes (task outcomes involving the receiving Agent after an
offer, citation and follow signals) accumulate as score events on the skill;
persistently poor candidates **retire**. Every proposal, verdict, and outcome is
appended to the **Proposal Ledger**, which preserves rejected and retired
proposals in full and is required reading before proposing — the paper's
`skill-impact.md` discipline. The reference stack's paired-replay hard gates and
constrained-Pareto release criteria are not ported (no replay infrastructure;
would require its own ADR).

**E. The Memory Agent is the sole retrieval surface (Q4, Q8).** One managed,
Workspace-scoped, fenced agent (runtime profile denies general tools — the
profile capability is ported from the branch) wakes on every PublicChannel
message, runs bounded Memory Explorations (idempotency-keyed, citation-grounded),
publishes cited Memory Offers, and answers explicit mentions. Working agents
never query the store directly: every memory flow is visible channel traffic
through one accountable identity. Offer-delivery records double as the shadow
gate's signal substrate (D). Exploration expands along the edge classes of
Decision I.

**F. LearnedSkill artifacts follow the reference stack's `skill-artifact/2.0`
(Q9, Q10).** Immutable revisions identified by `(lineage, version, content
digest)`; evidence references throughout the body; validation against a closed
schema before admission (a canonicalizer discipline — proposer output is not
authoritative until it passes). v1 supports two kinds:

- `step_guidance` — causal context (facts with evidence references) plus atomic
  `when → action → future` branches, each branch carrying its evidence support
  and a success/failure-risk disposition. The direct correspondent of the
  paper's procedural skills.
- `procedure` — a stable ordered instruction list with pre/postconditions. The
  branchless degenerate form.

`composite` and `tool` kinds are future ADRs. Rendering to a SKILL.md-compatible
guidance view happens at delivery time (Memory Offers), not at storage time.

**G. Proposer: server-side worker on the paper's cadence (Q11, Q12).** The
proposer runs on the Workspace model configuration after each distillation
sweep, reads the insight index, the Proposal Ledger, and on-demand evidence
through the exploration API within a bounded step budget, and produces exactly
**one atomic proposal per pass** (create / revise / no-action). The maintainer's
evidence sampling is stratified failure-first (at most 5 failing + 3 passing
recent episodes into one pass). The distill→propose sweep chain shares one daily
per-Workspace budget and one lock.

**H. Privacy and enablement (Q13).** DirectConversation content never enters any
layer, for any purpose. Enablement is the Memory Agent designation row: the
system is on for a Workspace exactly when the designation exists (default off);
enabling creates the managed Agent, the designation, and the PublicChannel
memberships in one action — the branch's ADR 0054-H pattern.

**I. Provenance edges connect the three layers; exploration traverses them.**
Every cross-layer "where did this come from" relation is an authoritative
record, written transactionally with the layer above, never inferred after the
fact:

- `episode —supports→ insight` / `episode —contradicts→ insight` — written by
  critique passes when an Insight is created or revised (the operation cites
  its episodes);
- `insight —distilled_from→ skill proposal` and `episode —evidenced_by→ skill
  proposal` — the proposal's grounding references, enforced at canonicalizer
  admission (F);
- `skill revision —supersedes→ previous revision` — written when a proposal is
  accepted into the lineage.

Memory Explorations expose these as traversal edge classes — `interactions`
(within the raw layer), `episodeInsight` (raw ↔ wiki), `skillGrounding`
(wiki → skill), `skillLineage` (within a skill lineage) — so a session can walk
from a message to the Episodes containing it, to the Insights those episodes
support or contradict, to the LearnedSkills grounded in those insights. This is
the reference stack's `supported_by`/`supersedes`/`derived_from` projection-edge
family, promoted to authoritative records. It does not resurrect the rejected
Memory Graph projection (see Rejected alternatives): provenance edges are
structured facts of origin; the similarity seam remains the seeding mechanism
only. `derived_from` (merge provenance) arrives with composite/merge support in
a future ADR.

## Rejected alternatives

- **Basing on `feat/group-memory` (or merging it first).** Deferred by product
  decision: standalone keeps the loop shippable without the branch's own merge
  review; vocabulary alignment keeps the eventual merge cheap.
- **Validation-split hard gating / paired replay** (paper + reference stack).
  No grader, no deterministic fake runtime in a product environment. Shadow
  signals carry the audit and course-correction duties instead.
- **Freeform SKILL.md artifacts** (the paper's format). Unversioned prose
  cannot carry evidence references, exact identity, governed retirement, or
  schema validation; the reference stack's structured artifact is adopted
  instead, with SKILL.md as a render target only.
- **Tool-level event capture in v1.** Needs a new daemon telemetry boundary;
  future ADR (recorded in C).
- **A separate Memory Graph projection on main.** Exploration expands along
  Interaction Links plus the lexical similarity seam; a derived graph
  projection is not needed for v1. This is a deliberate divergence from the
  branch's substrate, recorded here.

## Consequences

- main gains its own Group Memory substrate; the shared vocabulary makes a
  later merge with `feat/group-memory` conceptual rather than terminological.
- The ADR numbering collision with the branch (0052–0055) is accepted and will
  be renumbered at merge.
- Shadow gating means v1 never rejects a proposal on arrival; retirement is the
  only removal path, and the ledger keeps every attempt visible forever.
- The proposer is an LLM writer behind a validation discipline: proposal bodies
  pass the closed schema before admission, mirroring the reference stack's
  canonicalizer boundary.

## Validation and rollback

Per slice: value-semantics integration tests — link-extraction idempotency and
losslessness (natural language never creates an edge), episode admission
replay (byte-identical accepted, drift rejected), insight critique idempotency
and score-event append-only, artifact schema validation (closed kinds, exactly
one body, digest identity), canonicalizer admission rules, one-proposal-per-pass
with no_action, ledger append-only, offer cooldown/gate/atomicity, fenced-profile
tool denial, designation-fenced sweeps. Rollback: additive schema and new server
modules; revert the slice.

## Implementation slices (each shippable and testable independently)

1. **Substrate**: Prisma models (interaction links, episodes, insights + score
   events + episode↔insight provenance edges, skill artifacts, skill proposals
   + ledger + grounding edges, designation) + lossless link extraction + episode
   admission; value tests.
2. **Maintainer**: distillation worker — outcome / critique / merge passes,
   prompts, failure-first sampling, daily budget + lock (critique writes the
   supports/contradicts edges).
3. **Artifacts + proposer**: step_guidance/procedure schema validation and
   digest identity, canonicalizer admission (grounding edges enforced),
   supersedes-edge writing at acceptance, the one-proposal-per-pass worker,
   ledger writes.
4. **Memory Agent + exploration + offers**: exploration API with the four
   traversal edge classes (interactions / episodeInsight / skillGrounding /
   skillLineage), fenced runtime profile port, cited offer publication with
   cooldown, enablement lifecycle.
5. **Shadow gate wiring**: offer-delivery → outcome signals → skill score
   events → retirement.
6. **Real-LLM E2E smoke set.**
