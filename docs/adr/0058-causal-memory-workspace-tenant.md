# Causal Memory is the Workspace-owned group-memory engine

**Status: accepted (implementation pending confirmation).** CoForge will completely replace the Episode → Insight → LearnedSkill group-memory engine on a dedicated feature branch with a server-owned Causal Memory integration. Web/backend will operate a pinned upstream Causal Memory HTTP runtime and map each CoForge Workspace to an isolated Causal Memory tenant; tenant credentials remain server-only, and no Computer or Agent process receives them. New Causal Memory stores start empty: historic Group Memory data remains outside the new retrieval system rather than being mechanically transformed into causal facts.

Only admitted PublicChannel collaboration segments will be sent to Causal Memory: the raw segment is retained in its audit/session layer and the resulting extracted facts and causal edges form the retrieval layer. DirectConversation content remains excluded. A Memory Agent receives causal-native, read-only tools (`causal_search`, `causal_trace`, and `causal_intervention`) through Coforge's existing capability fence, while all ingestion remains server-owned; Causal Memory failure must not block ordinary group messaging. The upstream source is Apache-2.0 and must be pinned to an exact reviewed Git commit in the Coforge build rather than following `main` or a floating package release.

## Considered options

- Retain the old model as a fallback or run dual writes: rejected because the approved scope is a complete replacement and two retrieval truth sources would make a Memory Offer's evidence ambiguous.
- Run a SQLite store per Computer or Agent: rejected because a Workspace's public-channel memory would fragment across installations and move shared memory authority outside Web/backend.
- Give the Memory Agent direct MCP access: rejected because it would expose tenant credentials or unconstrained remote-tool access to an Agent process.
- Migrate Episode, Insight, and LearnedSkill rows mechanically: rejected because those models' inferred provenance is not equivalent to a Causal Memory fact or causal edge.

## Consequences

Coforge must supply a server-owned adapter, tenant lifecycle, pinned-runtime delivery, health checks, and a structured citation contract suitable for audited Memory Offers. The pinned upstream runtime will carry a small, tenant-authenticated Coforge extension that writes immutable PublicChannel turns to the upstream audit/session layer, explicitly distills only admitted segments, and returns structured facts, causal edges, and provenance. Distillation uses a dedicated server-owned model credential, never an Agent runtime credential. An admitted segment is either a completed Task discussion window or a PublicChannel quiet window; DirectConversation content never becomes an admitted segment. Disabling Group Memory stops ingestion and retrieval while retaining the tenant DB for re-enable; deleting the Workspace removes that tenant DB through a retryable, observable cleanup operation. The final implementation must update the architecture baseline, replace obsolete Group Memory persistence and retrieval paths, and add a public-channel scenario test that proves tenant isolation, admitted-segment ingestion, causal recall, a grounded offer, and non-blocking failure behavior.

Sources: [Causal Memory repository](https://github.com/JingxuanC/causal-memory/tree/9657b24), [Causal Memory HTTP multi-tenant documentation](https://github.com/JingxuanC/causal-memory/tree/9657b24#multi-tenant-http-per-tenant-databases). Content was rephrased for compliance with licensing restrictions.


## Operating rules

The Memory Agent observes PublicChannel messages without a server-side semantic prefilter. An explicit `@memory` question requires it to run a causal query before answering; otherwise it autonomously decides whether a causal tool call and a Memory Offer are useful. It remains read-only: when it identifies contradictory evidence, it submits a Causal Correction Proposal rather than invalidating or superseding tenant data itself. Web/backend owns the eventual correction decision and write.


Causal Correction Proposals that cite both an existing conclusion and contradictory admitted evidence are adjudicated by the dedicated server-owned model. A positive verdict soft-supersedes the old conclusion while preserving it and its provenance for audit. Proactive Memory Offers have no cross-message cooldown.


For an explicit human `@memory` question, the Memory Agent selects one active PublicChannel Agent as the Memory Offer recipient. The recipient-selection rationale and citations are retained in the offer audit record. Each triggering message may perform at most three causal reads and publish at most one visible Memory Offer; reaching either limit stops the turn silently and records a diagnostic.


All PublicChannel bodies are untrusted evidence, not instructions: ingest, distillation, and correction prompts carry them as identified data records; structured output is schema-validated and rejected unless it cites admitted segments and source messages. Every Memory Offer citation records the tenant-local causal item, Admitted PublicChannel Segment, and source Message IDs, together with the recipient-selection rationale. The verification plan has a deterministic local integration layer in CI and a separately opt-in live-LLM smoke test against a dedicated test tenant.


Each deployment environment runs exactly one internal Causal Memory HTTP runtime with a persistent SQLite volume. All Web/backend replicas call that runtime over the private deployment network; Caddy never exposes it publicly. It is an availability-isolated memory dependency: failure skips memory work rather than blocking group messaging.


Web/backend reuses its existing Redis-locked sweep coordination to identify admitted segments. The winning replica invokes Causal Memory with stable segment, message, and operation identifiers; duplicate delivery is a replay/no-op rather than a second distillation.


Web/backend persists an admitted-segment ingest ledger with immutable source message IDs/hash, a stable operation ID, state, and sanitized error summary. Causal runtime outages never delay messages; Redis-locked sweeps retry pending or transient failures until the idempotent ingest succeeds.


The internal Causal Memory persistent volume receives managed encrypted, application-consistent SQLite snapshots. Recovery starts a replacement runtime, verifies health/readiness and tenant isolation, then switches the internal endpoint.


The replacement migration drops the legacy Group Memory Prisma tables and all of their historical data. No legacy PostgreSQL backup or runtime fallback is retained; recovery applies only to the new Causal Memory tenant snapshots and the new Web/backend ingest ledger.
