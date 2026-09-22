# ADR 0059: Agent visibility

Status: accepted
Date: 2026-09-21
Decided by: Frank

## Context

Every Agent in a Workspace is visible to every member today: the members directory, @mention
candidates, add-to-channel candidates, the workspace info roster, created-agents lists and Activity
feeds all show every Agent unconditionally. A member needs to be able to keep an Agent to
themselves, and the weekly-report Collector Agents (ADR 0032), which work on one User's own
records, should not appear to the rest of the Workspace at all.

Raft Computer 1.0.32 has no per-Agent visibility concept to align with. Its only related setting is
a Server-level `hideHumansFromMembers` toggle — hides every human from the members list, server-wide
— which is a different axis (humans, not Agents; server-wide, not per-Agent) and does not generalize
to "some Agents are private." These rules are CoForge's own.

## Decision

**A. `Agent.visibility`: `"public" | "private"`, default `"public"`.** Existing rows stay public;
no data migration. The Agent create form offers Public/Private, defaulting to Public (creating an
Agent stays Workspace owner/admin only). New weekly-report Collector Agents (ADR 0032) are created
`"private"`; an Agent-prepared `agent:create` action card creates `"public"`.

**B. Who can see a private Agent.** A viewer (human or Agent) can see a private Agent iff any of:

- the human viewer is the Agent's creator (`Agent.ownerId === userId`);
- the Agent viewer has the same creator as the target (`viewerAgent.ownerId === agent.ownerId`;
  this includes an Agent seeing itself);
- the viewer's own Workspace server role is owner/admin — a human's `WorkspaceMembership.role`, or
  an Agent's own `Agent.role` (ADR 0024's Agent-role authority, reused unchanged).

A public Agent is visible to everyone in the Workspace, unchanged.

Everyone else never sees it listed: a private Agent they cannot see is missing from every list
(members, add-to-channel candidates, @mention candidates, workspace info roster, created-agents
lists, Activity feeds), and a lookup by id/name/handle — for example from an avatar on one of its
past messages — answers a stable "not visible" result with none of its details. The Web profile panel shows "这个 Agent 不可见" / "This
Agent is not visible" with no further detail; the Agent CLI gets a stable error code
(`AGENT_NOT_VISIBLE`) with an explanation, following the existing rule that a failure states its
real reason on a real wire field.

**C. Manage stays independent of see-and-DM.** Start/stop/restart/reset/delete/config keep their
existing authorization rules; additionally, a caller who cannot see a private Agent gets `NOT_FOUND`
for any manage operation on it — the same "absent" shape visibility failures use elsewhere. Owner/
admin is the one case that diverges from "see implies interact fully": an owner/admin **can** see
and manage another member's private Agent, but may **not** open or send a DM with it — a private
Agent's direct conversation stays scoped to its own creator. The creator's plain member-role Agents
still cannot manage it (the existing `Agent.role` management rule, unchanged).

**D. Channels never contain a private Agent.** A private Agent is never an active channel member.
Creating a private Agent does not enroll it in `#general`. Adding a private Agent to any channel is
rejected, and a private Agent can neither join nor create a channel.

**E. Changing visibility, both directions.** Only the Agent's creator or a human Workspace
owner/admin may change it; there is no Agent CLI command for it.

- **public → private**: the Web UI shows a confirmation dialog listing the consequences below,
  then: soft-leave every channel including `#general` (the existing `softLeaveMember`/`leftAt`
  mechanism — ADR 0024/0031); every existing DM between the Agent and a person who can no longer
  see it becomes read-only (history stays readable, neither side can send); channel Tasks already
  assigned to it are left untouched; its past messages keep their name and avatar unchanged.
- **private → public**: re-join `#general` only (no other channel membership is restored); DMs
  become writable again; Activity history from the private period becomes visible with no special
  redaction or migration.

**F. Realtime stays Daemon-unchanged; the Web publish proxy re-routes.** The Daemon keeps publishing
Activity to the one shared `agent:activity:<workspace_id>` channel exactly as before — it has no
concept of visibility. The publish proxy
(`apps/web/src/server/agents/agent-activity-publish.server.ts`) reads the Agent's current
`visibility` per event: for a public Agent it republishes to the shared channel as today; for a
private Agent it still records history/display, but instead republishes the same binary frame
(unchanged, via the Centrifugo server API `publish`, b64data) to a **per-Agent** channel,
`agent:activity:<workspace_id>:<agent_id>`, and refuses the shared broadcast. `agent:display`
snapshots follow the same per-Agent-or-shared split, on every `agentStatusChannel` publisher, using
the matching per-Agent status channel, `agent:status:<workspace_id>:<agent_id>`.

Per-Agent channels only ever mint a subscription token for a viewer who can currently see that
Agent (`apps/web/src/server/auth/browser-realtime-token.server.ts`); a viewer who cannot see the
Agent is never authorized to subscribe, so the private channel name itself carries no information
to someone who cannot already see the Agent.

On a visibility change, the server publishes an id-only `agent:visibility_changed` event on the
existing shared status channel (`agent:status:<workspace_id>`) — visible to everyone, since it
names no more than an Agent id already known to the roster. A browser that receives it refetches its
Agent list, drops the Agent from its caches if it is no longer visible to that viewer, or
(re)subscribes to its per-Agent channels if it still is.

## Rejected alternatives

**A workspace-wide `hideHumansFromMembers`-style toggle.** Raft's setting hides an entire class of
member server-wide; it does not express "this one Agent is private to its creator," which is the
actual product need (Collectors, and any future Agent a Workspace member wants to keep to
themselves).

**Visibility as a channel-membership side effect only (no `Agent.visibility` column).** Hiding a
private Agent from lists and mentions needs a queryable predicate independent of channel state — an
Agent with zero channel memberships is not necessarily private, and a private Agent's Activity/DM
rules have nothing to do with channels. A first-class column is the single source of truth every
seam (`visibleAgentWhere`, `canSeeAgent`, the publish proxy, the mention/roster queries) reads.

**Encoding "not visible" as a generic `NOT_FOUND` for lookups too.** Kept the same HTTP/status shape
(404-equivalent, no detail leak) but as its own `AGENT_NOT_VISIBLE` code so the Web profile panel and
the Agent CLI can render the specific "not visible" copy instead of a generic "not found," while disclosing none of the Agent's details. Its existence is not secret: its past messages
keep its name and avatar (E).

## Consequences and migration

- Additive schema change only (`Agent.visibility String @default("public")`); no backfill, no
  breaking wire change — visibility is Web-only and never crosses to the Daemon or the wire
  protocol.
- The realtime split adds one more channel dimension (per-Agent `agent:activity:<...>:<agent_id>`
  and `agent:status:<...>:<agent_id>`) alongside the existing shared channels; `docs/architecture.md`
  and the root `AGENTS.md` Agent Activity invariant are updated in the same change to describe both.
- This ADR (the foundation slice) adds the column, the domain vocabulary
  (`apps/web/src/features/agents/agent-visibility.ts`), and the single authorization seam
  (`apps/web/src/server/agents/agent-visibility.server.ts`: `AgentVisibilityViewer`,
  `visibleAgentWhere`, `canSeeAgent`, `assertAgentVisible`, and the two viewer builders) without
  wiring any call site. Wiring the roster/mention/channel/manage/DM/publish-proxy call sites, the
  visibility-change flow (confirmation dialog, soft-leave, DM read-only transition,
  `agent:visibility_changed`) and the per-Agent realtime channels themselves are follow-up slices
  building on this seam.

## Validation and rollback

- Unit tests cover the full rule table in `apps/web/test/agent-visibility-authorization.test.ts`:
  creator, an Agent sharing that creator (including itself), another member, another member's
  Agent, a human owner/admin, an admin-role Agent, the Workspace owner, and a public Agent visible
  to everyone — plus `visibleAgentWhere` and `canSeeAgent` asserted to agree row for row over the
  same roster.
- `mise run test`, `mise run check`, `mise run build`.
- Rollback is the release: reverting the CR(s) drops the seam and the column migration; because
  every existing row defaults to `"public"` and no call site is wired yet in this slice, rollback of
  the foundation slice alone has no user-visible effect.
