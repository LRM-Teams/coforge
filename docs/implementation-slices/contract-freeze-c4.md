# C4 — Integrated Contract Freeze Record

Reviewer: ZCode coordinator-reviewer (user-delegated). Date: 2026-09-21.
Inputs: C1 (`apps/web/src/server/workspace-memory/`, `apps/web/src/server/openviking/`),
C2 (`packages/coforge-sdk/src/agent/{memory-citations,openviking-memory,memory-tool-fences,causal-memory}.ts`),
C3 (repo `causal-memory`, crate `causal-memory-fact-index`).

## Cross-contract matrix

| Concept | C1 (web) | C2 (SDK) | C3 (Rust) | Verdict |
|---|---|---|---|---|
| Workspace profile | `off \| openviking \| causal_openviking` | codec rejects profile names as fence | — | one name, one source |
| observed state | `provisioning\|ready\|degraded\|switching\|error` | — | — | web-owned |
| Agent tool fence | — (not a web concept) | `openviking-memory`, `causal-openviking-memory`, legacy `causal-memory` | — | SDK-owned, maps from profile via codec |
| Gateway route class | `data-plane \| typed-control-only \| denied`, unknown → denied | — | — | web-owned |
| Actor identity classes | owner/admin→workspace_admin, member→own_namespace, agent→explicit_grant, memory agent→readonly_shared, projection worker→projection_only | — | — | web-owned |
| Citation kinds | — | `kind: "openviking" \| "causal_memory"` | — | SDK-owned |
| matched level | — | `"L0"\|"L1"\|"L2"` | `enum MatchedLevel { L0, L1, L2 }` | consistent |
| fact version | — | `factVersion: number` (int ≥ 1) | `fact_version` | consistent (camelCase/snake_case per language) |
| generation | monotonic profile generation | (not an SDK concept) | `generation` epoch on FactIndex | two distinct, non-conflicting generations: profile vs projection; both monotonic |
| watermark | — | — | CM-side watermark in every `search` | CM-owned (OV has none — D3 fact) |
| activation cursor | `ActivationCursor`, single validator `isAfterActivationCursor` | — | — | web-owned, no-backfill enforced at admission |
| budget | — | 4800 shared / 1600 default / 3200 max / 10 candidates / 3 reads / 1 offer | — | SDK-owned constants |

## Freeze decisions

1. Names above are frozen. Downstream tasks (P*, G*, O*, V*, R*, F*, A*) consume but
   must not edit these contract files without a new reviewed change.
2. Legacy unversioned `CausalCitation` remains accepted **only** by the pre-existing
   causal slice decode path. All new code uses `decodeMemoryCitation` /
   `CausalMemoryCitation`. F4 must not blur the two.
3. Watermark is defined as CM generation + successfully-applied outbox sequence
   (per design review); never derived from OV timestamps.
4. Deterministic causal retrieval must use OV `/search/find` (never `/search/search`
   with default `query_expansion=auto`) — recorded from D3.
5. tags/filter round-trip stability for fact id/version/generation was deferred
   to I1/V1.4. **V1.4 recorded verdict (2026-09-22, OpenViking `e44ea6e` +
   local-embed):** `POST /api/v1/search/find` `tags` and the equivalent
   metadata `filter` round-trip fact id / version / generation exactly. V1
   retrieval may rely on that path. `GET /fs/attrs` does **not** echo `k=v`
   tags; attrs-based scenes must use stable URI + Causal Memory-side binding.
   This is a recorded close-out of the deferral, not a rename of frozen
   citation or Fact Index fields.

## Post-freeze operational notes (not contract renames)

- Prototype ops envelope (secret host mode `644`, non-internal Docker
  network, host-downloaded local-embed weights, 2–4 minute warmup) is
  recorded in [`docs/operations/openviking-prototype.md`](../operations/openviking-prototype.md)
  and the [approval ledger](approval-ledger.md). It does not change C1/C2/C3
  names.
- Typed `DELETE /api/v1/admin/accounts/{id}` returns 202; upstream registry
  settle is unreliable. Cleanup contracts stay “accepted delete”, not
  “account list empty”.
- `factVersion` remains `number` ≥ 1 on the SDK citation. Web persistence
  currently prefix-encodes it onto `causalPathId` (`__vN__:…`) because the
  Prisma citation row has no dedicated version column. That encoding is an
  implementation residue, not a frozen wire rename.

Verdict: **contracts frozen (C4 complete)**. Wave 3 unblocked: P1, P2, G1, A1–A3, I1.
V1.4 closed C4#5 without reopening the freeze.
