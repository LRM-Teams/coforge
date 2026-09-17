# ADR 0034: Agent control authorization follows Raft's capability table

Status: accepted
Date: 2026-09-17

## Context

CoForge's Agent detail page offers three user-initiated control actions — Restart, Reset
Session, and Full Reset — implemented as one fixed command chain per action in
`AgentControl.execute()` (`apps/web/src/server/agents/agent-control.server.ts`). Before this
record, `execute()` authorized every action the same way: `authorized()` required
`agent.ownerId === userId`, i.e. only the Agent's own owner could Restart, Reset Session, or Full
Reset it. A Workspace admin — who can already create, edit, and manage every other Agent in the
Workspace (`assertCanCreateAgents`, `updateAgentRole`) — could not restart an Agent owned by
someone else, and no Workspace member other than the owner could restart their own team's Agent
when it misbehaved.

Raft Computer 1.0.32 (the reference build; see `docs/agents/reference-cli-research.md`) defines
its permission model in `shared/src/serverPermissions.ts` as a capability table per Workspace
role. Two entries are relevant here:

- `controlAgentRuntime` — held by the server owner, admin, **and every plain member**.
- `resetAgentWorkspace` — held by owner and admin only (admin holds every capability except
  billing; the member row does not include this one).

Raft has no "only the Agent's creator may control it" rule at all — Agent ownership does not
enter its Agent-control authorization. The product owner decided CoForge should follow Raft
exactly here (2026-09-17), including the point where it narrows today's behavior: an Agent's own
owner, if only a plain Workspace `member`, loses the ability to Full Reset an Agent they created,
because `resetAgentWorkspace` requires owner/admin regardless of who owns the Agent record.

No prior ADR recorded CoForge's previous owner-only rule as a decision; it was implicit in
`AgentControl.execute()`'s single `authorized()` check. This record is the first to name and
document Agent-control authorization as its own decision.

## Decision

`execute()` — the only user-initiated control path — now authorizes by the actor's current
Workspace membership and a two-name capability seam, not by Agent ownership:

- `restart` and `reset-session` require `controlAgentRuntime`: any actor with a current
  `WorkspaceMembership` row for `agent.workspaceId` (`owner | admin | member`).
- `full-reset` requires `resetAgentWorkspace`: the actor's Workspace role must be `owner` or
  `admin`. An Agent's own owner who is only a plain `member` is rejected.
- A non-member of `agent.workspaceId` is rejected exactly as before, with the same
  `"Agent is not authorized or assigned"` error.

`apps/web/src/server/workspaces/member-role.server.ts` gains the named seam, next to
`isAdminLike`/`assertCanCreateAgents`: `AgentControlCapability` (`"controlAgentRuntime" |
"resetAgentWorkspace"`), `hasAgentControlCapability`, and `assertHasAgentControlCapability`
(`AppError("ACCESS_DENIED")` on denial, this codebase's existing convention — see
`assertCanManageMembers`). This is a two-capability seam scoped to Agent control, not a general
capability framework.

`AgentControlStore` (the interface `AgentControl` depends on) gains `memberRole(workspaceId,
userId)`, returning the actor's current `WorkspaceMemberRole` or `undefined` when not a member.
`PrismaAgentControlStore.memberRole` reads `WorkspaceMembership` directly. This is deliberately
independent of `AgentControlStore.get()`'s existing owner-membership check (`PrismaAgentControlStore.get()`
still requires the Agent's **owner** to be a current Workspace member, and `replace()` still CASes
on `ownerId`) — that check is about the Agent record staying valid, not about who may act on it.

The internal/system paths are untouched: `recover()` (ready recovery) and
`publishStart()`/`publishStop()` (config-change confirmation, launch wake) still call the
original `authorized()` (Agent-ownership) check, called with the Agent owner's id or the editing
user's id by their existing callers (`agent-runtime-control.server.ts`, `agents.functions.ts`,
`routes/api/agent-api-keys.ts`, `server/centrifugo/rpc-composition.server.ts`). `authorizeLaunch()`
never took an actor identity at all — it scopes purely on Workspace/Computer match — so it is
unaffected by this record either way. This record narrows and widens only the human-initiated
button path.

### UI

`getAgentDetail` (`apps/web/src/features/agents/agents.functions.ts`) already computed
`canManageAgentRole` (`isAdminLike` on the viewer's own `WorkspaceMembership`) for the existing
Agent-role control; it now also returns `canFullResetAgent` (the same computation, named for this
capability). `AgentControl` (`apps/web/src/features/agents/agent-control.tsx`) is no longer gated
behind `detail.ownedByCurrentUser` — any Workspace member viewing an Agent's detail page (already
guaranteed by `getAgentDetail`'s own membership-scoped query) sees Restart and Reset Session; the
dialog's option list includes Full Reset only when `canFullResetAgent` is true. The server remains
the authority; this is convenience gating only, and a denied `full-reset` still surfaces
`AppError("ACCESS_DENIED")` to an inline (never toast) error message
(`m.agent_control_access_denied`), following the same pattern as
`channel-members-dialog.tsx`'s `ACCESS_DENIED` handling.

## Rejected alternatives

- **Leave Full Reset owner-gated, only widen Restart/Reset Session to admins**: rejected — this
  would still deny a Workspace admin Full Reset authority Raft gives them, and it would keep two
  different authorization shapes (ownership vs. capability) for actions in the same dialog for no
  reason beyond "that's what it already did."
- **Let an Agent's own owner always Full Reset it, in addition to owner/admin**: rejected per the
  product owner's explicit instruction to follow Raft exactly; Raft's `resetAgentWorkspace` has no
  ownership carve-out, and CoForge introducing one here would be a deviation, not an alignment.
- **A general Workspace capability framework** (arbitrary capability names, a lookup table keyed
  by capability across all features): rejected as premature — only two capability names are
  needed for this one control surface; `channel-authority.server.ts` (ADR 0032) already
  demonstrates the pattern of a small, feature-scoped authority seam over a general one, and this
  record follows the same discipline.

## Consequences

- `apps/web/src/server/workspaces/member-role.server.ts`: additive — new
  `AgentControlCapability`/`hasAgentControlCapability`/`assertHasAgentControlCapability`, no
  existing export changed.
- `apps/web/src/server/agents/agent-control.server.ts`: `AgentControlStore` gains a required
  `memberRole` method (every implementer must add it); `execute()`'s authorization now calls a new
  private `authorizedForExecute`, leaving the original `authorized()` untouched for
  `recover`/`publishStart`/`publishStop`; `authorizeLaunch` never used it.
- `apps/web/src/server/db/repositories/agent-control.repositories.server.ts`: `PrismaAgentControlStore`
  implements `memberRole` via a direct `WorkspaceMembership` read.
- `apps/web/src/features/agents/agents.functions.ts`: `getAgentDetail` response gains
  `canFullResetAgent` (additive field).
- `apps/web/src/features/agents/agent-control.tsx` / `agent-detail.tsx`: `AgentControl` gains a
  required `canFullReset` prop; the section's visibility gate changed from
  `detail.ownedByCurrentUser` to unconditional (any viewer of the page).
- `apps/web/messages/en/agents.json` / `zh-CN/agents.json`: new `agent_control_access_denied` key.
- Test stores implementing `AgentControlStore` (`apps/web/test/agent-control.test.ts`,
  `agent-control-runtime.test.ts`, `agent-session.test.ts`) all gained a `memberRole` fake
  returning `"owner"` — every existing test's actor already was the Agent's owner, so this is
  additive scaffolding, not a behavior change to any existing assertion. No existing assertion in
  these files was weakened or deleted. New tests in `agent-control.test.ts` cover: a non-owner
  member can Restart/Reset Session; a non-owner member cannot Full Reset (`ACCESS_DENIED`); a
  non-owner admin can Full Reset; a non-member is rejected with the existing message; an Agent's
  own owner who is only a plain member cannot Full Reset it (the deliberate narrowing this record
  introduces); `recover`/`publishStart`/`publishStop` stay owner-authorized and ignore
  `memberRole()` entirely.

## Validation and rollback

Validation: `bun run check` (formatting, lint, typecheck across all workspaces) and
`bun test apps/web/test/agent-control.test.ts apps/web/test/agent-control-runtime.test.ts
apps/web/test/agent-session.test.ts`, plus `bun run --cwd apps/web build` (route/loader data
shape changed). See the CR/report for verbatim pass counts.

Rollback is reverting the CR before merge. Post-merge, the safest rollback is a follow-up CR that
restores `execute()`'s single ownership check, removes `canFullResetAgent`/`canFullReset` and the
UI's unconditional visibility, and drops `memberRole` from `AgentControlStore` and its
implementations; no schema or migration is introduced by this record, so nothing needs to run in
reverse.

## Supersession

No prior ADR recorded the owner-only Agent-control rule as a decision (it was implicit in
`AgentControl.execute()`'s code), so this record supersedes no other ADR. It is the first to name
Agent-control authorization as its own decision.
