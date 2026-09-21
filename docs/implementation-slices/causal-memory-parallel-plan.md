# Causal Memory complete-replacement implementation plan

**Status:** approved design; implementation plan.  
**Branch/worktree:** `feat/causal-memory` at `/home/zhoujie22/river2_0/.worktrees/coforge-causal-memory`.  
**Decision source:** [ADR 0058](../adr/0058-causal-memory-workspace-tenant.md), [`CONTEXT.md`](../../CONTEXT.md), and [architecture baseline](../architecture.md).

This plan replaces the former Group Memory model entirely. It does not create a dual-read path, does not migrate legacy memory rows, and ends with a destructive Prisma migration that removes legacy Group Memory tables and data without a legacy backup. The prior `feat/learned-skill` worktree is read-only reference material only: do not merge or cherry-pick its legacy memory implementation into this branch.

## Delivery shape

```text
W0: freeze contracts and ownership
          ├─ W1-A: Causal Memory extension + contract tests
          ├─ W1-B: runtime packaging, private topology, backups
          ├─ W1-C: Prisma replacement schema + Web repositories
          └─ W1-D: Agent/SDK/Daemon causal tool contract
                         ↓
W2: Web/backend adapter, lifecycle, ingest, offers, corrections
                         ↓
W3: deterministic end-to-end group-chat scenario
                         ↓
W4: opt-in live-LLM smoke, full gates, independent review
```

Only W0 is serial. Within W1, workstreams own disjoint files and run concurrently. W2 begins as soon as W1-A and W1-C expose their tested interfaces; W1-B and W1-D can still finish while its server implementation proceeds.

## W0 — serial contract freeze

| ID | Deliverable | Owner/files | Exit criteria |
|---|---|---|---|
| W0.1 | Confirm `origin/main` is the implementation base and record the current reviewed Causal Memory commit in the build manifest. | `docs/`, build manifest; local `../causal-memory` checkout | No legacy Group Memory code is imported; exact upstream revision is reproducible. |
| W0.2 | Write versioned, framework-free contracts for the private Causal Memory extension and the Agent-facing causal commands. | `packages/coforge-sdk/`, `apps/web/src/server/causal-memory/` contract files | Contracts cover tenant auth, stable operation IDs, idempotent replay/conflict, raw-turn audit, admitted-segment distill, structured reads, citations, correction proposals, and sanitized errors. |
| W0.3 | Establish the test seams before implementation. | Test plan comments / contract test files | Seams are: extension HTTP contract; Web CausalMemory module; Agent local proxy contract; public-channel scenario. No UI tests. |

**W0 dependency:** all later work uses the exact contract names and JSON shapes frozen here. Changes after W0 require updating the contract tests first.

## W1-A — pinned Causal Memory extension

**Owner boundary:** only the local `../causal-memory` checkout and its integration/build patch. No Coforge app, SDK, or deployment files.

1. Create a patch branch from the exact reviewed upstream commit; keep stdio MCP behavior unchanged.
2. Add a private, tenant-authenticated, versioned Coforge HTTP surface on the existing Causal Memory runtime. It must provide:
   - idempotent audit-only turn insertion using stable Coforge message IDs, channel/thread session identity, ordering, timestamp, and payload hash;
   - explicit admitted-segment distillation, never implicit every-message distillation;
   - typed `search`, `trace`, and `intervene` reads returning display content plus machine-readable causal item, causal path, source-segment, and source-message citations;
   - structured correction adjudication input/output with only a soft-supersede write after a positive verdict;
   - tenant-scoped health/readiness and sanitized failure codes.
3. Preserve tenant isolation and prohibit `/debug/*` or a default-store endpoint from becoming the Coforge evidence path.
4. Add Rust unit/integration tests for tenant isolation, replay, operation drift, raw-not-searchable behavior, explicit distillation, citation provenance, and correction soft supersession.
5. Produce an exact patch/commit artifact consumed by W1-B.

**Exit criteria:** a local test process can create two tenants, write the same message ID separately, prove no cross-tenant recall, and return structured citations grounded in the correct tenant's admitted segment.

## W1-B — runtime delivery, private topology, and recovery

**Owner boundary:** `infra/`, build/release configuration, operations docs. Do not modify application domain code.

1. Build the exact W1-A Causal Memory revision into one Rust runtime artifact.
2. Provision one internal runtime per deployment environment, a persistent SQLite volume, private-only service discovery, tenant token secret injection, server-owned distillation-model secret injection, `/healthz` and `/readyz` checks, and no Caddy route.
3. Add application-consistent encrypted SQLite snapshot scheduling and recovery runbook: replacement runtime, restore, health/readiness, tenant-isolation smoke, then internal endpoint cutover.
4. Document resource limits and the non-blocking memory-degraded operational mode.

**Exit criteria:** two Web/backend replicas can target the same internal runtime; runtime credentials are absent from browser, Daemon, Agent process, logs, and command arguments.

## W1-C — replacement Web persistence and repositories

**Owner boundary:** `apps/web/prisma/`, `apps/web/src/server/causal-memory/` persistence/repository modules, migration tests. Do not call the runtime or modify Agent tools.

1. Add a Web-owned Causal Memory data model:
   - Workspace tenant lifecycle/configuration projection;
   - admitted-segment ingest ledger with immutable source message IDs/hash, stable operation ID, state, retry metadata, and sanitized error summary;
   - segment-to-message source rows;
   - structured citation records for offers and correction proposals;
   - correction-proposal/audit records and supersession result.
2. Author and review Prisma migration SQL. In the same approved migration, drop all legacy Group Memory, Episode, Insight, LearnedSkill, legacy citation, legacy offer, and associated historical tables/data. Do not create a legacy backup or compatibility view.
3. Implement repositories enforcing Workspace scope, immutable source identity, operation replay/conflict behavior, and tenant cleanup when a Workspace is deleted.
4. Add PostgreSQL tests for isolation, ledger replay, temporary failure scheduling state, delete semantics, and citation provenance.

**Exit criteria:** one public-channel segment can become a durable pending ledger row; a replay is stable; a cross-Workspace reference is rejected; legacy tables are absent after migration.

## W1-D — SDK, Daemon, and fenced Agent causal tools

**Owner boundary:** `packages/coforge-sdk/`, `packages/daemon/`, `packages/agent/` plus their focused tests. Do not alter Web persistence or upstream Rust code.

1. Replace old memory-explorer command vocabulary with framework-free causal command/response contracts.
2. Map the fenced tool profile to:
   - `causal_search`;
   - `causal_trace`;
   - `causal_intervention`;
   - `memory_offer`;
   - existing channel message read/send capability required for conversation context.
3. Enforce per-trigger turn budget: no more than three causal reads and one visible Offer. Include stable operation IDs and strict payload validation at Agent, local proxy, Daemon, and Web boundaries.
4. Update the Memory Agent instruction: explicit `@memory` requires a causal query; ordinary PublicChannel messages leave query choice to the Agent; it may submit a correction proposal but cannot mutate causal data.
5. Add focused tool serialization, allowlist, proxy auth/path, malformed-input, and budget tests.

**Exit criteria:** the Memory Agent cannot access shell/filesystem/generic network tools or causal tenant credentials, and cannot issue invalidate/supersede writes directly.

## W2 — Web/backend causal-memory module

**Owner boundary:** `apps/web/src/server/causal-memory/`, thin raw HTTP route adapters only where the Agent protocol requires them, and server integration tests. This work consumes W1-A and W1-C contracts.

### W2.1 `CausalMemory` module

Implement one deep server module that hides private runtime HTTP, tenant-token lookup, timeouts, error mapping, structured-result validation, and source/citation normalization. Its interface should express four intent-level operations: ingest an admitted segment, search, trace/intervene, and adjudicate a correction proposal. It returns typed evidence, never raw tenant tokens or unvalidated runtime strings.

### W2.2 admission and durable ingest

Reuse existing Redis-locked sweeps. Task-completed discussion windows and quiet PublicChannel windows create immutable admitted-segment ledger rows. The winning replica submits audit turns first, then explicit distillation. Runtime outage marks a temporary failure and returns control to normal message handling; later sweeps retry from the ledger.

### W2.3 Memory Agent reads, offers, and corrections

1. The Web Agent route authorizes only the designated Workspace Memory Agent.
2. Read responses validate the runtime citation set, bind it to the Agent turn/operation, and expose only the structured result expected by W1-D.
3. `memory_offer` chooses one active channel Agent, validates the cited evidence came from this tenant and served query, persists recipient-selection rationale, creates one public-channel delivery, and applies no cross-message cooldown.
4. A correction proposal cites a currently valid causal item and contradictory admitted evidence. Web/backend calls the dedicated adjudicator; only a positive response soft-supersedes the causal conclusion and persists its audit result.
5. All message text is untrusted evidence: it is passed as identified data, not executable instructions; schema/citation validation is mandatory before persistence or delivery.

**Exit criteria:** a runtime failure is visible in the ledger but never blocks a message; a forged/missing citation cannot create an Offer or correction; an explicit `@memory` request reaches the causal read contract.

## W3 — deterministic group-chat integration scenario

**Owner boundary:** integration tests and deterministic Causal Memory fixture/runtime harness. It depends on W1-A through W2.

Create one scenario through real Coforge PublicChannel, membership, admission, Agent HTTPS/proxy, and offer-delivery seams:

1. Create two Workspaces and public channels; enable the Memory Agent in both.
2. Send a uniquely marked, completed Task discussion in Workspace A; admit and distill it through the local Causal runtime fixture.
3. Send an explicit `@memory` question; assert a causal read occurs and exactly one cited Memory Offer is delivered to an active Agent chosen with an auditable rationale.
4. Assert the result cites the tenant-local causal item, admitted segment, and original Message IDs.
5. Assert Workspace B cannot retrieve or receive Workspace A evidence.
6. Add a negative probe: unrelated chat produces no required read/Offer; malformed citation and runtime outage do not block normal messages; retry subsequently ingests the segment.
7. Add a correction fixture: contradictory admitted evidence yields a proposal and a soft-supersede audit record while retaining old evidence.

No UI unit tests are added. Any affected UI is recorded for manual validation only.

## W4 — live smoke, gates, and review

1. Add an opt-in real-LLM smoke, guarded by explicit environment variables and a dedicated disposable tenant. It validates public channel → admission → automatic distillation → explicit `@memory` → grounded Offer, then cleans tenant data.
2. Run targeted upstream Rust tests, Web PostgreSQL integration tests, Agent/Daemon tests, deterministic scenario, and runtime build checks during the slices.
3. Before review run `mise run test`, `mise run check`, and `mise run build` in the Coforge worktree; separately run the pinned Causal Memory Rust test/lint suite.
4. Update operations/release documentation with the exact upstream commit, patch hash, service configuration, backup/restore test evidence, model-secret requirements, and live-smoke invocation.
5. Request independent Standards and Spec review against ADR 0058 and this plan; resolve findings before a commit or PR is proposed.

## Parallelism and file-ownership rules

| Workstream | May run with | Must wait for | Files it must not touch |
|---|---|---|---|
| W1-A upstream extension | W1-B, W1-C, W1-D after W0 | W0.2 | `coforge/**` |
| W1-B runtime delivery | W1-A, W1-C, W1-D after W0 | W0.1 | application, SDK, and upstream source files |
| W1-C Web schema/repositories | W1-A, W1-B, W1-D after W0 | W0.2 for final DTO names | Agent/Daemon/upstream files |
| W1-D SDK/Daemon/Agent tools | W1-A, W1-B, W1-C after W0 | W0.2 | Web persistence/upstream files |
| W2 Web causal module | W1-B, W1-D | W1-A extension and W1-C repositories | upstream and deployment files |
| W3 deterministic scenario | focused unit tests in W2 | W1-A through W2 | production files unless a failing scenario exposes a defect |
| W4 live smoke/gates/review | documentation work | W3 | feature behavior during review unless fixing a reviewed defect |

## Completion criteria

The replacement is complete only when all conditions hold:

- The exact patched upstream revision is reproducibly built and privately deployed as one persistent runtime per environment.
- The old Group Memory runtime and database tables are gone, with no backup or fallback read path.
- All tenant access, raw audit ingestion, extraction, citation, offers, and correction writes are Workspace-scoped and server-authorized.
- The Memory Agent has only the four causal/offer capabilities plus required message I/O, never direct tenant credentials or causal mutation tools.
- The deterministic group-chat scenario proves isolation, admission, read, Offer provenance, correction behavior, non-blocking outage, and retry.
- The opt-in live smoke has documented passing evidence before production promotion.
- Required Coforge and Causal Memory validation gates pass, then an independent review approves the change.
