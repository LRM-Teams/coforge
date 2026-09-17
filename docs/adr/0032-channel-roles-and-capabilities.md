# ADR 0032: Channel-level roles and capabilities

Status: accepted
Date: 2026-09-17

## Context

Raft Computer 1.0.32 (the reference build; see `docs/agents/reference-cli-research.md`) exposes,
per channel member, a `serverRole` (the Workspace-level role), a `channelRole` (a role stored on
the membership itself), and a `channelAdminBasis` (why this member counts as a channel admin —
"why", not just "whether"). Per channel, for the acting Agent, it exposes `channelRole`,
`channelAdminBasis`, and `channelCapabilities` (a map of capability name → boolean). `channel
members` prints the per-member detail as a bracket, `[server role=<r>, channel role=<r>, admin
via=<basis>]`, each part only when present; `channel info` prints `Channel role:`/`Channel admin
basis:`/`Channel capabilities:` lines the same way. Raft's own prompt text states the rule these
fields exist to support: "Existing channel management commands ... are authorized per channel; a
channel-admin role never grants delete, visibility, federation, or server-profile actions. There
is no Agent command for changing channel roles."

Before this record, CoForge had no channel-level role at all. Two prior records approximated
channel-management authority with coarser, channel-blind gates:

- ADR 0024 gated the Agent CLI's `update`/`archive`/`unarchive`/`remove-member` on
  `agentHasAdminAuthority` — the acting Agent's own **server** role (`Agent.role` owner/admin),
  identical on every channel, with no channel-specific concept at all.
- ADR 0031 (this branch's merge base moved past it while this branch was in flight; see
  "Consequences") gated the human `PublicChannels.removeMember` on
  `assertCanRemoveChannelMembers` — the acting human's Workspace role (owner/admin), same
  channel-blind shape, and computed `members()`'s `canRemoveMembers`/`canLeave` booleans directly
  from that Workspace role rather than from any per-channel authority concept.

Neither record gives CoForge a way to say "this specific human or Agent administers *this*
channel without being a Workspace owner/admin" — the gap Raft's `channelRole`/`channelAdminBasis`
close. This record adds that missing layer and unifies both prior gates behind it.

## Decision

### Schema

`ConversationMember.channelRole String @default("member")`, values `admin | member` (one
generated migration, `channel_member_roles`, additive and default-backed). Channel creators —
human `PublicChannels.create`, Agent `AgentChannelManagement.create`, and the `channel:create`
action-card commit path (which calls the same `PublicChannels.create`, so no separate change was
needed there) — get `channelRole: "admin"` on their own membership row at creation. `#general`
members always stay `"member"`; nobody can be `#general`'s channel admin, matching its other
fixed rules (it can never be renamed, archived, or have a member removed by anyone else).

### Admin basis (computed, never stored)

`apps/web/src/server/conversations/channel-authority.server.ts` is the one module both the human
and Agent paths read: `deriveChannelAdminBasis(serverRole, channelRole)` returns `"server_role"`
when the actor's server role (a human's `WorkspaceMembership.role`, or an Agent's own
`Agent.role`) is owner/admin; otherwise `"channel_role"` when the membership's stored
`channelRole` is `"admin"`; otherwise `undefined`. When both apply, `"server_role"` is reported —
matching Raft's own `channelAdminBasis` precedence. `resolveChannelAuthority(db, workspaceId,
actor, channel)` is the async orchestration: it reads the actor's server role and the actor's own
membership row for that channel, derives the basis, and derives the capability matrix below, in
one seam every gated operation calls instead of re-deriving authority ad hoc.

### Capabilities (exactly eight names)

`post`, `leave`, `add_member`, `update`, `archive`, `unarchive`, `remove_member`, `manage_roles`.
`deriveChannelCapabilities` (pure, unit-tested independent of the database) computes:

- **Active membership alone** grants `post`, `leave` (never on `#general`), `add_member` (ADR
  0025) — independent of admin basis.
- **Either admin basis** additionally grants `update`, `archive`, `unarchive`, `remove_member`
  (never on `#general`), independent of active membership — a server admin who has never joined
  a channel can still archive it (Raft's model: a channel-admin role is scoped to the channel,
  but a *server*-role admin's authority is not).
- **`manage_roles`** is human-only (Agents never change channel roles — Raft: "There is no Agent
  command for changing channel roles" — CoForge has no Agent CLI/API route for it either) and
  requires either admin basis, never on `#general` (nobody can be its channel admin, so there is
  nothing to manage there).
- Delete, visibility, and server-profile actions are deliberately not in this list — Raft's own
  prompt text says a channel-admin role never grants them, and CoForge has no such actions on
  channels regardless.

### Agent CLI/API surface

- `channel info` (`AgentChannelInfo`): gains `channelRole?` (present only while the acting Agent
  is an active member), `channelAdminBasis?` (present only when it has either basis), and
  `channelCapabilities` (always present, every name, only the callable ones `true`).
  `packages/coforge/src/channel-format.ts`'s `formatChannelInfo` renders `Channel role:`/`Channel
  admin basis:`/`Channel capabilities: <comma-separated true-only names>` between `Joined:` and
  `Muted:`, matching Raft's exact line order; see "Deviations from Raft" for the one rendering
  choice this record made differently.
- `channel members` (`AgentChannelRoster`): each roster entry's `role` field is renamed
  `serverRole` (Raft's own field name; the CLI's existing `roleLabel`-style `(admin)`/`(owner)`
  suffix now reads it under the new name) and gains `channelRole`/`channelAdminBasis` — present
  for a `#channel` roster (every listed member is active there by definition) and absent for the
  `@user` DM roster, which has no channel-role concept at all. `formatChannelMembers` appends a
  Raft-`channelMemberRoleDetail`-style bracket, `[server role=<r>, channel role=<r>, admin
  via=<basis>]`, after the existing role suffix.
- **Authority for `update`/`archive`/`unarchive`/`remove-member`** (`AgentChannelManagement`):
  replaces ADR 0024's channel-blind `agentHasAdminAuthority` with
  `hasChannelAdminAuthority(db, workspaceId, { agentId }, channel)` — channel-aware, either basis.
  This is purely additive for the Agent CLI: the old check (global `Agent.role` admin/owner) is
  exactly the `server_role` basis, so every previously-authorized Agent stays authorized on every
  channel; an Agent whose own `channelRole` on one specific channel is `"admin"` (e.g. because it
  created that channel) is now *also* authorized there, without needing `Agent.role` elevated at
  all.
- No Agent command changes channel roles — matching Raft exactly. `packages/daemon/src/code-agent
  /agent-instructions.ts` gained Raft's own per-channel-authorization prompt line, verbatim in
  spirit: "Channel management commands ... are authorized per channel; a channel-admin role never
  grants delete, visibility, federation, or server-profile actions. There is no Agent command for
  changing channel roles."

### Human side

- `PublicChannels.members` (`apps/web/src/server/conversations/public-channels.server.ts`, shared
  by the human dialog and the Agent CLI, unchanged in that respect) gains the acting actor's own
  `channelRole`/`channelAdminBasis`/`channelCapabilities`, and each member entry's `serverRole`
  (renamed from `role`, matching the CLI-side rename above)/`channelRole`/`channelAdminBasis`.
- `PublicChannels.setChannelRole(workspaceId, actorUserId, channelId, member: ChannelActor, role)`
  is the new human-only mutation: it requires the actor's `manage_roles` capability and rejects
  `#general` outright (`AppError("CONFLICT")` — there is nothing to promote or demote there).
  `setPublicChannelMemberRole` (`channels.functions.ts`) exposes it to the browser.
  `ChannelMembersDialog` shows an "Admin" `Badge` on a channel-admin row and, when the viewer's
  `channelCapabilities.manage_roles` is true, a Promote/Demote `Dropdown` action per human and
  Agent row — the same Badge+Dropdown pattern the Workspace Members panel already uses for
  Workspace roles. There is no equivalent Agent CLI/API route, matching Raft.
- **`PublicChannels.removeMember` now uses the `remove_member` capability** instead of ADR 0031's
  `assertCanRemoveChannelMembers`: a channel admin via `channelRole` (not only a Workspace
  owner/admin) may remove a member from a channel it administers — the human-side symmetry to the
  Agent CLI's own `remove-member`, which ADR 0024 already gated this way. This is additive
  authority, never a narrowing: every actor `assertCanRemoveChannelMembers` allowed (Workspace
  owner/admin) still passes, via the `server_role` basis.
- **`members()`'s `canRemoveMembers`/`canLeave`** (ADR 0031) become plain aliases of
  `channelCapabilities.remove_member`/`.leave` rather than their own, separately-computed
  booleans — one source of truth for "can this actor remove members here" instead of two that
  could drift.

## Deviations from Raft

- **CLI text hides the default `"member"` value**, for both `channel info`'s `Channel role:` line
  and `channel members`' bracket detail — `channelMemberRoleDetail` in Raft's own source checks
  only field truthiness (a non-empty string), which would print `server role=member` for every
  ordinary member if CoForge's server always populated the field (which it does, unlike Raft's
  apparent practice of omitting it server-side for a plain member). CoForge chose to keep the
  `serverRole`/`channelRole` fields always populated when relevant (simpler, honest data) and
  instead filter the *rendering* the same way the pre-existing `roleLabel`/`(admin)` suffix
  already does — never showing the uninformative default. The response data itself is unaffected;
  only the CLI text renderer's threshold differs.
- **`manage_roles` and the admin-authority capabilities are unavailable on `#general`** even for a
  `server_role`-basis actor. Raft's capability list is a server-defined map ("the server-side
  values are ours to define"); CoForge chose to make this concrete rule — "nobody can be channel
  admin of `#general`, its rules are fixed" — show up consistently in the capability matrix
  itself, not only in the individual operations that already refuse `#general` (`update`,
  `archive`/`unarchive`, `remove-member`, `leave`). This keeps a UI or CLI reader from ever seeing
  "you can manage roles here" for a channel where no role change is actually possible.

## Rejected alternatives

- **Keeping two separate authority checks** (`agentHasAdminAuthority` for the Agent CLI,
  `assertCanRemoveChannelMembers` for the human `removeMember`) and only adding `channelRole` as
  inert stored data: rejected — this would leave the two paths free to drift exactly the way ADR
  0024/0025 already had to reconcile once, and it would not let a channel-only admin (no server
  role at all) administer their own channel, defeating the point of introducing `channelRole`.
- **A separate `channelCapabilities` computation for humans and Agents**: rejected in favor of one
  pure function (`deriveChannelCapabilities`) parameterized by `isHuman` for the one place that
  differs (`manage_roles`); every other capability is identical logic for both actor kinds.
- **Letting a channel admin's `channelRole` also unlock delete, visibility, or server-profile
  actions**: rejected outright — Raft's own prompt text says a channel-admin role never grants
  these, and CoForge does not implement channel delete or private/visibility channels at all, so
  there is nothing for this record to gate either way.

## Consequences

- `apps/web`: one additive Prisma migration (`channel_member_roles`); new
  `channel-authority.server.ts` module; `agent-channel-authority.server.ts`
  (`agentHasAdminAuthority`) deleted, replaced by `hasChannelAdminAuthority`/
  `resolveChannelAuthority`; `member-role.server.ts`'s `assertCanRemoveChannelMembers` deleted
  (superseded, see below) along with its `workspace-member-role.test.ts` case;
  `PublicChannels.create`/`members`/`addMembers`/`removeMember` changed (creator gets
  `channelRole: "admin"`; `members`'s per-member `role` renamed `serverRole` and gains
  `channelRole`/`channelAdminBasis`; the top-level response gains the actor's own three fields;
  `removeMember`'s authority source changed); new `PublicChannels.setChannelRole` and
  `setPublicChannelMemberRole` Server Function; `AgentChannelManagement.info`/`members`/`update`/
  `setArchived`/`removeMember` changed the same way on the Agent side.
  **Not purely additive**: `PublicChannels.members`'s per-member `role` field is renamed to
  `serverRole`; the one caller outside this record's own test files (`channels.functions.ts`) does
  not read that field by name, so nothing else needed updating. `members()`'s
  `canRemoveMembers`/`canLeave` keep their names and meaning (a strict superset of ADR 0031's
  original values) but change their computation.
- `packages/coforge-sdk`: `AgentChannelInfo` gains three fields; `AgentChannelRosterAgent`/
  `AgentChannelRosterHuman` rename `role` to `serverRole` and gain `channelRole`/
  `channelAdminBasis`. No route or method signature changed shape beyond these field-level
  additions/renames within existing response types.
- `packages/coforge`: `channel-format.ts` renders the new lines/bracket; existing renderers'
  function signatures are unchanged. `packages/daemon`'s `agent-instructions.ts` gained one prompt
  line.
- Test fixtures whose fixed shape gained/renamed a field were updated to match (a contract
  addition/rename, not a weakened assertion): `agent-channel-management-routes-http.test.ts`'s
  info/update/members fakes; `public-channel.integration.ts`'s existing "Agent channel management"
  scenario's roster/DM-roster assertions (renamed `role` → `serverRole`, added the new fields where
  the underlying actor's basis changed); `channel-format.test.ts`'s `formatChannelInfo`/
  `formatChannelMembers` cases (added `channelCapabilities`, renamed `role` → `serverRole`, and the
  new "Server and stored channel roles are shown separately when available." line Raft's own
  `formatChannelMembers` always prints, which CoForge's first pass at ADR 0024 had omitted).
  Three of the existing "Agent channel management" scenario's negative-authority assertions
  (`update`/`archive`/`remove-member` denial) had asserted a plain, non-admin Agent (`member.id`,
  the scenario's own channel *creator*) was denied — under this record, that Agent legitimately
  gained `channel_role` basis by creating the channel, so those three assertions now use a
  never-joined, plain-role Agent (`outsiderAgent`) instead, and three new positive assertions
  demonstrate the `channel_role` basis succeeding where the old assertions expected denial. This
  is a genuine behavior change (an Agent that creates a channel is now that channel's admin, as
  intended by this record), not a weakened test.

## Validation and rollback

Validation: `bun run check` and `bun run build` in `apps/web`, `packages/coforge-sdk`,
`packages/coforge`, `packages/daemon` (see the CR/report for verbatim pass counts); new
`apps/web/test/channel-authority.test.ts` (the pure capability-matrix unit tests: member, channel
admin, server admin, `#general`, left member, non-member); the extended `agent-channel-management-
routes-http.test.ts`; the extended and one new scenario in `public-channel.integration.ts`
(creator is channel admin; a plain member cannot archive; promoting via `setChannelRole` enables
archive, demotion revokes it; a server admin without membership can still archive; `#general`
never reports an admin capability; the Agent CLI's `update`/`archive`/`remove-member` gated by
channel role, both bases); `packages/coforge/test/channel-format.test.ts`'s extended cases;
`packages/daemon/test/agent-instructions.test.ts`'s new case. UI: no new UI unit test (repository
policy forbids them); the Promote/Demote control is added to the existing manual verification Todo
list (`docs/agents/testing.md`).

Rollback is reverting the CR before merge. Post-merge, the safest rollback is a follow-up CR that
removes the new routes/CLI/UI surface, restores `agentHasAdminAuthority`/
`assertCanRemoveChannelMembers`, and stops writing/reading `channelRole`; the column itself is
additive and default-backed, so no migration needs to run in reverse for existing rows to keep
working under the old code.

## Supersession

This record supersedes:

- **ADR 0024**'s authority table for the Agent CLI's `update`/`archive`/`unarchive`/
  `remove-member` (the `agentHasAdminAuthority` gate): it is replaced by the channel-aware
  `hasChannelAdminAuthority`/`resolveChannelAuthority`, additive in effect (every previously
  authorized Agent stays authorized; a channel-only admin gains authority it did not have
  before).
- **ADR 0031**'s `assertCanRemoveChannelMembers` gate for the human `PublicChannels.removeMember`
  and its `canRemoveMembers`/`canLeave` computation: both are replaced by the `remove_member`/
  `leave` capabilities from this record's shared authority module, additive in the same sense.

Neither ADR 0024 nor ADR 0031 is rewritten; this note and the matching notes added to both records
are the links both ways.
