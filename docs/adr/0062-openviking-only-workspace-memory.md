# Workspace memory is OpenViking-only; Causal Memory is removed

**Status: accepted.** CoForge workspace memory is OpenViking-only. The Causal Memory integration — the `causal_openviking` Workspace Memory Profile, the causal and causal-openviking tool fences, Causal Memory Citations, Causal Correction Proposals, the causal ingest sink, and the Causal Memory runtime client — is deleted rather than kept behind a flag. The Workspace Memory Profile keeps `off` and `openviking`. The policy-gateway design of ADR 0061 is unchanged.

The causal direction was falsified. Sustaining two memory authority models, two tool fences, two instruction sets, dual citation semantics, and dual cleanup cost more than the causal profile returned, and none of it ever reached `main`. The removal is branch-local: Causal Memory never merged and no deployed environment holds causal data worth preserving, so its migrations and schema models are deleted rather than counter-migrated.

## Considered options

- Keep Causal Memory behind the `causal_openviking` profile flag: rejected because a falsified direction kept alive still pays full fence, instruction, test, citation, and cleanup maintenance while promising a second memory truth model that will not ship.
- Keep dual-citation and dual-fence seams for a future re-introduction: rejected because the git history and the superseded ADRs preserve the design; a future return would be a new design against then-current evidence, not a restore.
- Demote Causal Memory to an OpenViking-internal Fact Index adapter (ADR 0059): rejected together with the direction itself.

## Consequences

ADR 0058 (Workspace tenant), ADR 0059 (internal Fact Index), and ADR 0060 (dual profiles) are superseded. ADR 0061 stands unchanged. The Memory Agent keeps its read-only OpenViking tools (`ov_find`, `ov_search_context`, `ov_read`, `memory_offer`), the per-trigger read and offer budgets, the explicit `@memory` answer rule, and the profile-neutral Memory Offer, now backed only by OpenViking Citations. The causal-memory server module is dissolved: its profile-neutral orchestration (memory-agent HTTP and route handling, offers, citations, budgets, admission, explicit answers, offer delivery) moves under `workspace-memory`, and OpenViking-only pieces move under `openviking`. Workspace deletion cleanup shrinks to the OpenViking account and binding steps. The causal-memory HTTP runtime, its configuration, and its infra leave the CoForge tree; the upstream Causal Memory project itself remains independent of this decision. The AGPL prototype gate (`OPENVIKING_PROTOTYPE_ENABLED`) and the license-review delivery gate are unchanged by this removal.
