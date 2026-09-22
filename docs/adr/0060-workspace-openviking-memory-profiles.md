# Workspaces choose complete OpenViking or Causal Memory augmented OpenViking

**Status: superseded by [ADR 0062](0062-openviking-only-workspace-memory.md) — the dual-profile model is replaced by OpenViking-only workspace memory.** Each CoForge Workspace chooses one Workspace Memory Profile: `openviking` or `causal_openviking`. The choice is Workspace-wide rather than per Agent or per query. Both profiles retain OpenViking's complete product capability; the causal profile additionally enables Causal Memory admission, canonical facts and causal edges, Hippocampus reasoning, grounded corrections, and a Managed Causal Projection inside OpenViking.

This profile selection is not the rejected natural-language intent router. In the causal profile, factual candidate retrieval and causal traversal may form one internal pipeline. Callers do not guess whether a mixed question belongs to a tree or a graph.

## Considered options

- Select OpenViking or Causal Memory independently for every query: rejected because mixed questions require both retrieval geometries and because admission, correction, and evidence authority cannot vary from one call to the next.
- Configure the profile per Agent: rejected because Agents in one Workspace would observe different group-memory truth and lifecycle.
- Send the same PublicChannel messages through both OpenViking memory extraction and Causal Memory distillation: rejected because two extractors would create competing facts, provenance, deletion, and correction authority.
- Give the designated Memory Agent unrestricted OpenViking mutation tools: rejected because untrusted PublicChannel evidence could induce resource, session, or skill mutations outside the causal correction workflow.

## Consequences

In the `openviking` profile, CoForge integrates OpenViking's full runtime interface, including its resource, filesystem, memory, skill, session/commit, hierarchical retrieval, task, watch, portability, and administration capabilities subject to CoForge authorization.

In the `causal_openviking` profile, those OpenViking capabilities remain available. Ordinary documents, imported resources, personal sessions, and skills stay in OpenViking's native write domain. Only admitted PublicChannel team memory enters the Causal Memory write domain: Causal Memory retains the immutable audit lineage, canonical Fact Documents, causal graph, lifecycle, correction decisions, and citation provenance, then projects active Fact Documents into a dedicated OpenViking namespace.

The Managed Causal Projection maps deterministic Fact Partitions to OpenViking directories. Directory L0 abstracts and L1 overviews provide navigation; projected Fact Documents are L2 leaves. OpenViking may generate and index the L0/L1 summaries, but they are retrieval aids rather than causal evidence. Partition membership, fact lifecycle, and citation eligibility remain owned by Causal Memory. Superseded Fact Documents leave the active projection while their canonical history remains available to causal trace.

Each Workspace receives an independent projection namespace, and returned projection records are checked against the Causal Memory Tenant before use. The designated Memory Agent retains its causal capability fence and may receive only explicitly approved read-only OpenViking retrieval operations. Full OpenViking administration and mutation remain available through separately authorized CoForge product surfaces and Agents.

ADR 0059 defines the internal Fact Index seam used by the causal profile. The same OpenViking runtime may host native OpenViking content and managed causal projections, but separate namespaces and write ownership must prevent either lifecycle from silently rewriting the other.

## Operating rules

Changing a Workspace from `openviking` to `causal_openviking` does not reinterpret existing OpenViking memories as causal evidence. The Causal Memory Tenant starts empty and admits only new eligible PublicChannel segments after activation. Changing back to `openviking` stops causal admission and retrieval but retains the tenant for a later re-enable. Any future historical import must explicitly replay original CoForge PublicChannel evidence through an audited admission process; OpenViking summaries are never silently backfilled as causal facts.

Each CoForge Workspace maps to one OpenViking account. Workspace humans and Agents map to account users, while Managed Causal Projection writes use a dedicated service identity restricted to a fixed subtree. Multiple Workspace accounts may share one OpenViking runtime, but directory naming alone is not a tenant isolation control.

Causal Memory commits canonical state and a durable projection outbox in one transaction. An asynchronous, idempotent projector writes the Managed Causal Projection. A projection failure never rolls back admitted evidence. Search results from OpenViking carry stable canonical fact and projection-version identifiers; Causal Memory hydrates them from its canonical store and rejects unknown, stale, superseded, or tenant-mismatched candidates.

The causal profile keeps a local canonical candidate-search fallback. When OpenViking is unavailable, local SQLite lexical retrieval may seed Hippocampus, and identifier-based trace or intervention continues to use the causal graph. Native OpenViking operations may report degraded availability, but neither OpenViking nor Causal Memory failure blocks ordinary group messaging.

Fact Partitions use deterministic admission scopes. Completed Task evidence projects under a stable Task partition; quiet PublicChannel evidence projects under a stable Channel and calendar-month partition. Context fingerprints remain causal fork metadata rather than directory paths. OpenViking may regenerate directory L0/L1 summaries without changing partition membership or canonical evidence.

The first delivery uses an existing OpenViking vector backend. LanceDB is not part of the initial integration. If later justified by retrieval or operating evidence, LanceDB belongs behind OpenViking's `CollectionAdapter` seam so both Workspace Memory Profiles benefit without changing Causal Memory's Fact Index interface.

## Initial delivery and authorization

The initial integration targets OpenViking's complete backend capability rather than a search-only subset. CoForge will make the runtime interface available through backend interfaces, SDK calls, and authorized Agent tools; dedicated native UI for every OpenViking capability is not part of the initial delivery.

A Workspace stores a desired profile (`off`, `openviking`, or `causal_openviking`) separately from its observed provisioning state (`provisioning`, `ready`, `degraded`, `switching`, or `error`). Profile changes are reconciled asynchronously because account, identity, tenant, namespace, and health operations cannot commit atomically.

OpenViking authority follows CoForge authority. Workspace Owners and Admins manage Workspace-level OpenViking configuration, ACL, and shared resources; Members retain their own user namespaces and explicitly shared access; ordinary Agents use distinct OpenViking users with explicit grants; the designated Memory Agent has read-only access to Workspace-shared content and the Managed Causal Projection; the projection worker can mutate only that projection. Operations personnel do not receive default business-content read access.

OpenViking remains on a private network. A CoForge gateway authenticates the caller, verifies Workspace authority, selects the mapped OpenViking identity, and forwards the allowed operation. Browsers and Agents do not retain Workspace administration credentials. Direct MCP or WebDAV access, if later required, must use short-lived delegated credentials with an explicit scope.

The local OpenViking source is AGPL-3.0 and has not received project-level approval for a distributable product integration. Therefore the initial implementation is an isolated interface and integration prototype only. It must not be presented as release-ready, added to a distributable artifact, or used to make production data available until the project owner completes the applicable license review and explicitly approves shipping. This ADR records a delivery gate, not legal advice.

## Profile persistence, prototype gate, and deletion

A generic `WorkspaceMemoryProfile` aggregate stores the desired profile, observed reconciliation state, generation, and sanitized failure. An `OpenVikingBinding` stores the mapped OpenViking account and service identity plus a secure credential reference; it is separate from the existing `CausalMemoryTenant`. Pure OpenViking operation must not require a misleading causal-tenant record, and credential plaintext does not belong in ordinary business tables.

Until AGPL use is explicitly approved, implementation remains in the causal-memory feature worktree behind an explicit `OPENVIKING_PROTOTYPE_ENABLED` gate that defaults off. OpenViking is excluded from default Compose, release manifests, and production deployment. A separate development override uses synthetic test data and is labeled `non-production / license-review-required`.

Changing or disabling a profile retains both OpenViking and Causal Memory data. `off` stops access and background processing but is not deletion. Deleting a Workspace enqueues durable, observable, retryable cleanup of its Causal Memory Tenant, OpenViking account, Managed Causal Projection, pending projection work, and binding records. Cleanup failure remains visible and is never reported as successful deletion.

## Team-memory admission, Agent tools, and citations

Both profiles use CoForge's Admitted PublicChannel Segment rule for automatic Workspace team memory: only completed Task discussion windows and PublicChannel quiet windows qualify, and DirectConversation content never qualifies. In the `openviking` profile, an admitted segment enters an OpenViking session/archive and may use OpenViking's native commit and memory extraction while retaining its segment ID, source Message IDs, and Workspace metadata. That lineage identifies the OpenViking source but is not represented as causal provenance. In the `causal_openviking` profile, the same admission enters Causal Memory's canonical distillation and projection flow. Other explicitly authorized OpenViking resources and personal sessions remain governed by their native workflows rather than this automatic team-memory rule.

The Memory Agent receives profile-specific read-only tools. In the `openviking` profile it may use `ov_find`, `ov_search_context`, and `ov_read`, with at most three reads and one visible Memory Offer per triggering message. In the `causal_openviking` profile it retains `causal_search`, `causal_trace`, `causal_intervention`, and `propose_correction`, and may additionally receive approved read-only OpenViking retrieval for document and resource questions. It cannot write files, commit sessions, mutate skills or ACLs, or bypass the causal correction workflow. Complete OpenViking mutation remains available only through separately authorized product surfaces and Agent roles.

OpenViking Citations and Causal Memory Citations remain explicit, distinct evidence types. An OpenViking Citation identifies the Workspace/account, URI, content hash or version, matched detail level, and display title or excerpt. A Causal Memory Citation identifies the causal item or path, canonical fact version, Admitted PublicChannel Segment, and source Message IDs. A response may carry both types, but an OpenViking URI or summary is never presented as admitted causal provenance.

## Implementation order

Delivery follows tracer bullets: revise the architecture walkthrough and normative documents for the two-profile model; freeze profile, gateway, and Fact Index contracts; add the profile aggregate and reconciliation skeleton; prove one complete read/write path through the deny-by-default OpenViking gateway; expand the classified route catalog to the complete approved runtime surface; add the Causal Memory projection outbox and local fallback; implement the OpenViking Fact Index adapter; integrate hierarchical retrieval and watermark-plus-local-delta merging; then complete profile switching, cleanup, deterministic verification, and the explicit opt-in real OpenViking smoke test.
