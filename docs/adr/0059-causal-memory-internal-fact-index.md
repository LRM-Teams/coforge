# Causal Memory owns an internal, replaceable Fact Index

**Status: accepted.** CoForge will continue to depend on Causal Memory as one deep group-memory module through its causal `search`, `trace`, and `intervene` interface. Retrieval backends such as OpenViking or LanceDB will not become peer memory runtimes selected by a CoForge-level query router. Instead, they may serve as adapters at an internal Fact Index seam owned by Causal Memory.

Causal Memory remains responsible for admitting evidence, distilling canonical Fact Documents, maintaining causal relationships, adjudicating corrections, and defining causal-query semantics. The Fact Index is a tenant-isolated, rebuildable projection of canonical Fact Documents. An adapter may change how facts are indexed and recalled, but it may not decide what constitutes a fact, reinterpret causal edges, become the sole owner of source evidence, or weaken citation provenance.

## Considered options

- Run Causal Memory and OpenViking as peer runtimes behind an intent router: rejected because mixed questions require both factual recall and causal traversal, natural-language routing is not a stable semantic seam, and callers would inherit cross-runtime consistency and failure modes.
- Replace the complete Causal Memory runtime with OpenViking: rejected because directory hierarchy and layered retrieval do not supply causal trace, intervention, typed inhibitory edges, correction adjudication, or causal-history semantics.
- Put directory paths, summaries, or wiki links directly into the Hippocampus graph as causal structure: rejected because containment and semantic association are not causal relationships.
- Keep SQLite-specific fact retrieval permanently embedded in the causal engine: rejected because factual candidate generation and token-efficient expansion can vary independently from causal reasoning, and at least OpenViking- and LanceDB-shaped implementations are expected to exercise that variation.

## Consequences

CoForge callers and the Memory Agent retain the existing causal interface and do not receive OpenViking-, LanceDB-, embedding-, collection-, or URI-specific concepts. Causal queries may use the Fact Index to identify candidate facts before Hippocampus graph expansion, but `trace` and `intervene` remain causal operations even when an adapter is unavailable.

Causal Memory must introduce a small backend-neutral Fact Index interface and a conformance suite shared by every adapter. The canonical store must retain enough Fact Document content, provenance, lifecycle, and projection version information to rebuild an empty or stale index. Index updates therefore use replayable projection work rather than transactional dual ownership.

The architecture walkthrough at `/home/zhoujie22/river2_0/causal-memory-vs-openviking.html` currently describes the rejected peer-runtime router and must be revised before it is treated as an implementation guide.

## Fact Index interface

The Fact Index interface has three operations: `apply(batch, generation)`, `search(query, limit)`, and `reset(generation)`. `apply` consumes idempotent projection commands for active Fact Document upserts, removals, and dirty Fact Partitions. `search` returns canonical fact identifiers, ranking scores, matched detail levels, projection versions, and an index watermark. `reset` starts a new projection generation for an empty rebuild. Backend paths, OpenViking URIs, collections, embeddings, summary tasks, and vector filters remain adapter implementation details.

Causal Memory owns outbox replay and rebuild orchestration. Business code never bypasses the seam to write an adapter directly. Candidate hydration checks the canonical tenant, active lifecycle, content version, and admitted provenance before a candidate can seed Hippocampus or become a citation.

## Retrieval budget, determinism, and freshness

Each triggering message may issue at most three causal reads sharing a 4,800-token budget. A read defaults to 1,600 tokens, may consume at most 3,200 tokens when the shared budget permits, and requests at most ten candidates. Exhausting the shared budget returns the evidence already assembled and never creates an implicit fourth read. The standalone OpenViking profile retains OpenViking's native configurable context budget.

Within the causal profile, OpenViking performs deterministic candidate retrieval only. Searches target the Managed Causal Projection, disable query expansion, do not load OpenViking session context, and do not run OpenViking long-term-memory extraction. Hierarchical L0/L1/L2 retrieval operates within the remaining shared budget. OpenViking ranking orders candidates; Causal Memory remains responsible for active fact state, causal expansion, and citation eligibility.

Every Fact Index search response carries an index watermark. Causal Memory merges OpenViking candidates at that watermark with active canonical facts changed after it, deduplicates the result, rejects unknown, stale, superseded, or tenant-mismatched candidates, and only then seeds Hippocampus. This watermark-plus-local-delta path provides read-your-writes while projection remains eventually consistent.

## Verification requirements

Automated Fact Index conformance tests cover replay/no-op, generation reset, active-only projection, Workspace namespace isolation, stale candidate rejection, and watermark-plus-local-delta merging. Gateway policy tests cover deny-by-default routing, identity-header stripping, Workspace actor mapping, destructive and administration authority, and Memory Agent mutation denial. Profile scenarios cover complete OpenViking operations, profile switches without historical backfill, admitted evidence flowing through canonical state into projection, OpenViking outage fallback, non-destructive switching, and durable Workspace cleanup.

A real OpenViking smoke test is explicit opt-in, uses synthetic data only, and is excluded from default CI while the license-review gate remains unresolved.
