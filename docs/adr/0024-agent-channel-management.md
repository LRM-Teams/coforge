# ADR 0024: Agent channel management (info, members, join, leave, create, update, lifecycle, add-member, remove-member)

Status: accepted
Date: 2026-09-17

## Context

Raft Computer 1.0.32 gives its Agents a `channel` command family covering lifecycle and roster
management, not just the mute/unmute attention preferences CoForge already had
(`packages/coforge/index.ts`, `apps/web/src/routes/api/agent/v1/channels_.$channel.mute.ts` /
`.unmute.ts`). Before this change, CoForge had no path for an Agent to join a channel other than
`#general` (`enrollGeneralChannel`, `apps/web/src/server/conversations/public-channels.server.ts`),
no `leave` for anyone, and no way for an Agent to create, rename, describe, archive, or manage the
roster of a channel. `ConversationMember` rows also could never be deleted once they owned a
`Message` or `Task` (`onDelete: Restrict` on `Message.sender` and `Task.owner`/`creator`), so any
new "leave"/"remove" semantics need a representation that does not delete the row.

## Decision

### Schema (migrations `channel_lifecycle_and_membership`, `agent_server_role`)

1. `Conversation.description String @default("")` — channel description, editable via `update`.
2. `Conversation.archivedAt DateTime?` — archive is a timestamp, not a boolean, so "when" is
   free; `archived` in every response is `archivedAt !== null`.
3. `ConversationMember.leftAt DateTime?` — a soft-leave marker. `leave`/`remove-member` set it;
   `join`/`add-member` clear it (upsert), keeping the same row so a member's read boundary
   (`agentReadThroughSequence`) and mute preference (`channelMuted`) survive a re-join. This is
   the only workable representation given the `Restrict` FKs above: a member who ever posted or
   owns a Task can never have their `ConversationMember` row deleted.
4. `Agent.role String @default("member")` — an Agent's OWN server role (`owner|admin|member`,
   validated with the existing `isWorkspaceMemberRole`/`isAdminLike` helpers from
   `apps/web/src/server/workspaces/member-role.server.ts`), matching Raft's `serverRole`. This
   supersedes an earlier draft of this record that derived an Agent's authority from its human
   owner's Workspace role (`Agent.ownerId` → `WorkspaceMembership.role`); Frank's decision was to
   match Raft's source instead of inventing a CoForge-specific stand-in. `agentHasAdminAuthority`
   (`apps/web/src/server/agents/agent-channel-authority.server.ts`) now reads `Agent.role`
   directly. A Workspace owner/admin can grant or revoke an Agent's `admin` role through the new
   `updateAgentRole` server function (`apps/web/src/features/agents/agents.functions.ts`), gated
   by `assertCanInvite` (never assigns `"owner"`), with a matching Select control in the Agent
   settings page (`apps/web/src/features/agents/agent-detail.tsx`).
5. No private/visibility column. **Private channels are explicitly out of scope**: CoForge's
   channel model is "every channel is public" (`docs/architecture.md`'s MVP invariant), and this
   record does not change that. The CLI accepts `--private`/`--public` for Raft argument
   compatibility and always rejects them (`CliError` code `UNSUPPORTED`).

### Active-membership predicate

`leftAt` makes "is X a member" a filter, not a row-existence check. One helper,
`ACTIVE_MEMBER_WHERE = { leftAt: null }` (`apps/web/src/server/conversations/active-member.server.ts`),
is applied everywhere a query answers "is this Agent/human currently a member" or counts/lists
members: `getAgentChannel`, `PublicChannels.list` (`joined`), `PublicChannels.join` (now an upsert
that clears `leftAt` instead of `createMany`/`skipDuplicates`, since `add-member`/`remove-member`
can now leave a human's row in a left state), `PublicChannels.send`'s member/recipient/mention
queries, `PublicChannels.setUserMuted`, `sendAgentMessage`'s in-memory sender lookup
(`direct-conversation.repositories.server.ts`), `searchMessages`/`resolveAgentScopedMessage`'s
conversation-membership scope, `setAgentMessageReaction`'s member lookup,
`unreadAgentMessagesFragment`'s raw-SQL join (Agent delivery/recovery selection), the notification
fan-out recipient query (`prisma-web-push-subscriptions.server.ts`), and `readAuthorizedAttachment`'s
Agent-membership branch (`attachment.server.ts`). DM (`directKey`) member rows never gain a
`leftAt` value in the current feature set — no operation here sets it for a DM — so adding the
filter there is a no-op that costs nothing and stays correct if that ever changes.

### Authority model

This record's first draft mirrored Raft's own gate: server-admin authority for every write
operation (`create`/`update`/`archive`/`unarchive`/`add-member`/`remove-member`). Frank then
decided in ADR 0025 (`docs/adr/0025-channel-membership-and-agent-creation-authority.md`, PR #289,
merged to `main` while this branch was in flight) that CoForge channels follow **Slack's**
defaults, not Raft's, and that the Agent CLI must apply the identical rules the human Web UI
already applies rather than a stricter, Agent-only gate. This record now defers to ADR 0025 for
every operation it actually covers, and only keeps `Agent.role` admin authority for the two write
operations ADR 0025 does not cover (`update`, `archive`/`unarchive`) plus the one it explicitly
deferred (`remove-member`):

- **`create`**: any Agent that belongs to the Workspace — membership only, no role gate — the
  same check `PublicChannels.create` runs for a human (ADR 0025 §1). The creating Agent becomes a
  member, same as a human creator.
- **`join`**: any Agent; unchanged from this record's original draft, and consistent with ADR
  0025 §1's "joining a channel stays open to any Workspace member."
- **`leave`**: any Agent, never `#general`; unchanged from this record's original draft.
- **`add-member`**: the acting Agent must itself already be an **active member** of the target
  channel — Slack's "you add people to channels you're in" (ADR 0025 §2) — not gated by
  `Agent.role`. `AgentChannelManagement.addMember` no longer implements this check itself: it
  resolves the `@handle` to an id (a genuinely unknown handle is its own 404, independent of the
  actor's membership) and calls the shared `PublicChannels.addMembers`, which enforces the active-
  membership rule and does the write, for both the human dialog and the Agent CLI. A denied
  request is `403` plain text `this Agent must be a member of #<channel> to add members to it`.
- **`update`** (rename/description) and **`archive`/`unarchive`**: `Agent.role` admin authority
  (`isAdminLike(agent.role)`) — Raft's gate, kept because ADR 0025 is silent on these two
  operations (they do not exist on the human side at all). A denied request is `403` plain text
  `this Agent's owner lacks admin authority for <operation>`.
- **`remove-member`**: `Agent.role` admin authority, and never `#general` — this is ADR 0025's
  own **planned, not-implemented** rule (§3: "by default Workspace owner/admin may remove someone
  from a public channel, and it is never possible to remove someone from `#general`"), implemented
  here via the soft `leftAt` marker ADR 0025 anticipated needing. Removing **yourself**
  (`--agent @<its own name>`) needs no admin authority, identical to `leave`. A denied request is
  the same `403 this Agent's owner lacks admin authority for remove-member` text as `update`/
  `archive`.

`agentHasAdminAuthority` (`Agent.role`, not a delegated owner role) remains the single switch for
every operation that still needs it (`update`, `archive`, `unarchive`, and `remove-member` except
self-removal); it is simply no longer called from `create` or `add-member`.

### Archive semantics

Archiving sets `archivedAt`; `#general` can never be archived, renamed, or have a member removed
by another Agent (`leave`/`remove-member` on `#general` is `400`). An archived channel refuses new
posts: `PublicChannels.send` and `sendAgentMessage` both check `archivedAt` and throw
`AppError("CONFLICT")`, which the human-facing route surfaces however it already surfaces
`AppError`s and the Agent send route (`apps/web/src/routes/api/agent/v1/messages.ts`) maps to `409`
text `channel is archived`. `channel join` on an archived channel is the same `409`. Read-only
operations (`info`, `members`, `mute`/`unmute`, history reads) are deliberately **not** gated on
`archivedAt` — an archived channel stays inspectable, matching `info`'s own `archived: boolean`
field and the `channel members`/`channel info` table in this record's CLI section. The only
human-facing change is hiding archived channels from the sidebar channel list
(`apps/web/src/features/conversations/conversation-navigation.tsx` filters on the new
`archived` field `PublicChannels.list` now returns); no other human UI changed.

### Server routes, SDK, daemon, CLI

- New Agent HTTP routes under `apps/web/src/routes/api/agent/v1/`: `channels.ts` (`POST` create),
  `channels_.$channel.ts` (`GET` info / `PATCH` update), `channels_.$channel.members.ts`
  (`GET`/`POST`/`DELETE`), `channels_.$channel.join.ts`, `.leave.ts`, `.archive.ts`,
  `.unarchive.ts`. All thin, delegating to `AgentChannelManagement`
  (`apps/web/src/server/conversations/agent-channel-management.server.ts`), which owns the
  business logic and throws `AgentChannelManagementError(status, message)` — a per-error HTTP
  status paired with the exact plain-text body, since these operations need `400`/`403`/`404`/
  `409` rather than mute/unmute's fixed `400`.
- **Reused, not reimplemented**: `AgentChannelManagement` takes a `PublicChannels` instance
  (defaulting to `new PublicChannels(db)`) and calls its `members`/`addMembers` methods for the
  `#channel` form of `channel members` and for `add-member`, instead of querying membership rows
  itself. `PublicChannels.members`/`addMembers` were generalized from a human-only `actorUserId:
  string` parameter to a `ChannelActor = { userId: string } | { agentId: string }` (`public-
  channels.server.ts`), and both now: (a) filter every membership query through
  `ACTIVE_MEMBER_WHERE`, and (b) use an upsert that clears `leftAt` instead of `createMany`/
  `skipDuplicates`, so adding back a soft-left member reactivates their row rather than silently
  no-op'ing. The Agent module's own code is limited to target grammar (`#channel`/`#channel:
  <thread>`/`@user`), resolving an `@handle` to an id, response shaping (role/self/live-status
  tags), and the two operations ADR 0025 does not cover (`update`, `archive`/`unarchive`) plus
  the one it deferred (`remove-member`, kept entirely in the Agent module — no human UI exists
  for it). The `@user` DM roster form has no `PublicChannels` equivalent (DMs are not named
  channels) and is queried directly, then shaped through the same `shapeAgentRoster` helper.
- `packages/coforge-sdk`: `agentApiRoutes.cloud.channels.{create,info,update,members,addMember,
  removeMember,join,leave,archive,unarchive}`, response types in the new `agent/channels.ts`
  (re-exported from `agent/index.ts`), and matching `AgentApiClient`/`RawAgentApiClient` methods.
  `agentApiRoutes.proxy.channels`/`local.channels` (`POST /api/agent/v1/channels`) carry the local
  daemon proxy's operation-based request, matching the existing `messages`/`tasks` pattern (plain
  JSON end to end — the local proxy payload for tasks is JSON already, not protobuf, and channels
  follows the same shape: `packages/coforge-sdk/src/internal/channel-command.ts`'s `ChannelCommand`).
- `packages/daemon/src/agent-proxy.ts` validates the `ChannelCommand` shape and dispatches to
  `runtime.agentChannel(context, request, agentApiKey)`
  (`packages/daemon/src/daemon-runtime/runtime.ts`), which forwards to
  `daemon-connection.ts#agentChannel`. That method maps the operation to its cloud route/method
  (`channelEndpointFor`) and returns the JSON response body unchanged; a network failure throws
  `AgentTransportError.preResponseTransport`, and a non-2xx upstream response throws
  `AgentTransportError.upstreamHttpResponse` carrying the real status (e.g. `404`) — not a bare
  `Error`, which would collapse to a generic "unclassified" `502` under `classifyAgentProxyFailure`
  and hide a real "channel not found" behind a retry-suggesting failure. `local-client.ts#callChannel`
  turns a classified `404` on a single-channel-target operation into `CliError` code `NOT_FOUND`.
  `mute`/`unmute` are untouched — they still travel through the generic message-operation proxy
  path.
- `packages/coforge`: `channel info|members|join|leave|create|update|lifecycle archive|unarchive|
  add-member|remove-member` parse in `index.ts` (`parseChannelManagementArgs`), transported by
  `local-client.ts#channel`, and rendered by the new `src/channel-format.ts`. `channel members`
  prints `(admin)`/`(owner)` after an Agent exactly as it does after a human (Raft's `roleLabel`),
  using the Agent's own `role` field the `channel members` route now returns for each Agent.
  Each Agent roster row also carries a live `status` (`online`/`offline`/`unknown`, "unknown"
  only when the server truly has no data) and, when online and doing something more specific
  than merely being connected, `activity`/`activityDetail` — Raft's `agentStatusLabel` inputs
  (`apps/web/src/server/agents/agent-channel-status.server.ts`, reading the same Redis-backed
  `AgentDisplay` the human-facing Agent detail page already reads). The CLI composes the label
  text (`online`, `offline`, `unknown`, or `online; working: running tests`) from those fields.
  `--private`/`--public` are parsed and always rejected (`CliError` code `UNSUPPORTED`).
  `agent-instructions.ts` gained two lines: join before posting to an unjoined channel, and use
  `channel members` to see who has join/post authority before assuming someone is reachable.

### Exact parity with Raft 1.0.32's channel formatters and validation

A line-by-line review against the Raft 1.0.32 bundle's `formatJoinChannelResult`/
`formatLeaveChannelResult`/`formatCreateChannelResult`/`formatUpdateChannelResult`/
`formatArchiveChannelResult`/`formatUnarchiveChannelResult`/`formatAddMemberResult`/
`formatRemoveMemberResult`/`formatChannelMembers`/`formatChannelInfo`/`agentStatusLabel`/
`roleLabel`/`parseRegularChannelTarget` found several places where CoForge's first pass paraphrased
Raft's text or behavior instead of matching it exactly (`raft` renamed to `coforge`, minus the
parts CoForge genuinely has no equivalent for — private channels, channel-level roles beyond
admin/owner, and the dynamic "attention" block Raft only attaches when the server supplies one).
Fixed, all in `packages/coforge/src/channel-format.ts` and `packages/coforge/index.ts` unless noted:

- **Success text and the booleans that select it.** Every write operation's route response
  gained a boolean the CLI needs to choose between Raft's "did it" and "already/was" text, and
  `AgentChannelManagement`/`PublicChannels.addMembers` compute it from data already read for the
  write (no extra query): `join` → `alreadyJoined` (checked before the upsert); `leave` →
  `wasMember` (`updateMany`'s row count); `add-member` → `alreadyMember` (`PublicChannels
  .addMembers` now also returns `alreadyMemberUserIds`/`alreadyMemberAgentIds`, queried before the
  write); `remove-member` → `wasMember` (`updateMany`'s row count, both the Agent- and
  human-target branches). `create`'s and `update`'s success text became their own one-liner
  (`formatChannelUpdate` no longer aliases `formatChannelInfo`); `join`'s success text gained
  Raft's fixed "Still arrives" block.
- **Roster line format.** `formatChannelMembers`'s Agent line is
  `  - @name (<status>)<role> — <description>` — status and role in separate parens, no
  description suffix when empty — and drops the "self" tag CoForge's first draft added: Raft's
  formatter has no self tag, only role and status. The human line, `  - @username<role>`, was
  already correct. `self` stays in the roster **data** (`AgentChannelRosterAgent.self`,
  `packages/coforge-sdk/src/agent/channels.ts`) for any caller that wants it — only the CLI's text
  renderer drops it.
- **`channel info`'s member count is always plural**, `Members: N (a agents, h humans)`, never
  singularized at a count of one — CoForge's first draft singularized, Raft does not.
- **CLI-side target validation matching Raft's `parseRegularChannelTarget`.** `join`, `leave`,
  `update`, `lifecycle archive|unarchive`, `add-member`, and `remove-member` now reject a non-
  regular target (an `@user` DM, a `#channel:thread` target, or a bare name with no leading `#`)
  at parse time, before any request is sent, with `CliError` code `INVALID_TARGET` and Raft's
  fixed message (`requireRegularChannelTarget`, `packages/coforge/index.ts`). `info`/`members`
  are unaffected — Raft accepts and normalizes a wider target grammar for those, and CoForge
  already did (`@user` for a DM roster, `#channel:thread` for `info`). Separately, an unknown
  channel reported by the server (a `404`) is `CliError` code `NOT_FOUND` with a fixed
  `Channel not found: #x` message, mapped client-side in `local-client.ts#callChannel` for the
  seven single-channel-target operations (`join`, `leave`, `update`, `archive`, `unarchive`,
  `add-member`, `remove-member`), using the `AgentTransportError` propagation fix described above.
- **`channel members @user` no longer creates a DM as a side effect.** Inspecting who could
  message in a DM must not start one — the same reasoning that keeps `info`/`members` off the
  `archivedAt` write-path gate. `AgentChannelManagement.members`'s `@user` branch now calls
  `PrismaDirectConversationRepository.findUserAgentConversation` (new, read-only: looks the
  `directKey` conversation up, never creates it) instead of `getOrCreateUserAgent`, and 404s
  `channel not found` when no DM exists yet.
- **The `attachment.server.ts` `ACTIVE_MEMBER_WHERE` sweep, completed.** Two human-membership
  predicates this record's original sweep missed — `storeAttachment`'s `members: { some: {
  userId } }` (~line 38) and `readAuthorizedAttachment`'s DM branch (~line 144) — now include
  `ACTIVE_MEMBER_WHERE`; the Agent-membership branch was already correct. A repo-wide re-grep for
  `members: { some: {` against `ConversationMember` (excluding the several `Workspace.members`/
  `WorkspaceMembership` hits, which are a different model and correct as-is) found no further
  gaps: `realtime.functions.ts`, `task-board.server.ts` (5 sites), `public-channels.server.ts`,
  and `reminder.repositories.server.ts` (3 sites) were already fixed by this record's original
  sweep or by ADR 0025/#289.

## Rejected alternatives

- **Deleting the `ConversationMember` row on leave/remove.** Rejected outright: the `Restrict` FK
  from `Message.sender`/`Task.owner`/`creator` makes this impossible once the member has ever
  posted or owns a Task, and "impossible for some members, works for others" is not a coherent
  contract.
- **Deriving Agent admin authority from `Agent.ownerId`'s Workspace role.** This record's first
  draft did this (a plausible design given Agents have no role of their own elsewhere in the
  schema), but it invents a CoForge-specific authority model where Raft has its own explicit
  `serverRole` per Agent. Matching the reference source is simpler to reason about and to compare
  against Raft, and avoids surprising an admin's Agents with authority the admin never granted to
  that specific Agent (or losing it silently if the human owner's own Workspace role changes).
- **Gating `getAgentChannel` on `archivedAt` globally.** Rejected: `getAgentChannel` backs read
  paths (`mute`/`unmute`, message read/search/resolve/react) that must keep working on an archived
  channel; only the write paths (`send`, `join`) need the archive check, and each already has its
  own resolution point to add it to.
- **A private/visibility column now, to match Raft's shape even if unused.** Rejected: CoForge's
  MVP invariant is that every channel is public, and adding an inert column invites drift between
  the schema and the contract. `--private`/`--public` are accepted and rejected at the CLI layer
  instead, which is enough for Raft-script compatibility.

## Consequences

- `apps/web`: two additive Prisma migrations (`channel_lifecycle_and_membership`,
  `agent_server_role`); every membership predicate listed above now excludes soft-left members;
  `PublicChannels.list`/the sidebar hide archived channels; `PublicChannels.send`/`sendAgentMessage`
  refuse archived-channel posts; a new `AgentChannelManagement` service, error type, authority
  helper, and nine route files; a new `updateAgentRole` server function and Agent-settings Select.
  **Not purely additive**: `PublicChannels.members`/`addMembers` (added by ADR 0025/#289) changed
  their second parameter from a bare human `actorUserId: string` to `ChannelActor = { userId:
  string } | { agentId: string }`; their two existing call sites in `channels.functions.ts` were
  updated to pass `{ userId }`. Their return shape gained fields (`role` on humans;
  `description`/`role`/`computerId` on Agents) that the human "Members" dialog does not read —
  additive from that dialog's point of view.
- `packages/coforge-sdk`: additive route/type/client surface; no existing route, type, or method
  changed shape.
- `packages/daemon`: additive `agentChannel` on `DaemonConnectionClient`/`DaemonRuntime`, a new
  local proxy route, and a new default HTTP client; `mute`/`unmute`/`tasks`/`messages` paths
  unchanged.
- `packages/coforge`: additive CLI surface and a new `channel-format.ts`; existing `channel mute|
  unmute --target` parsing and behavior unchanged.
- Test fixtures whose fixed shape gained a field were updated to include it (`PublicChannels.list`
  test assertions gained `archived: false`; `AgentDetailQuery` test fixtures gained `role`) — a
  contract addition, not a weakened assertion.
- The Raft-parity review above is also **not purely additive**: every write route's response
  shape gained a boolean (`alreadyJoined`/`wasMember`/`alreadyMember`), `formatChannelUpdate` is
  no longer `=== formatChannelInfo`, `formatChannelRemoveMember` gained a third parameter
  (`wasMember`), and `formatChannelMembers`'s Agent line dropped the "self" text tag (the `self`
  field itself is unchanged in the response data). Every call site and test asserting the old
  shapes/text was updated to match — see the counts below.
- Unrelated to this record: fixing `agent-session-persistence.integration.test.ts`'s hand-rolled
  `CREATE TABLE agents` (used to replay a specific migration sequence in an isolated schema) to
  include a `role` column. That table predates `Agent.role` and was never updated for it; the gap
  was invisible until this review ran the full suite with `MIGRATION_TEST_DATABASE_URL` set,
  which the deterministic-suite runs in earlier rounds of this record had not exercised.

## Validation and rollback

Validation: `bun run check`, `bun run test`, and `bun run build` at the repository root (see the
CR/report for the verbatim pass counts and the pre-existing, unrelated failures — process-adapter
and install-script tests untouched by this change); the new
`apps/web/test/agent-channel-management-routes-http.test.ts` (route handlers, with fakes); the new
scenario in `apps/web/test/public-channel.integration.ts` (authority, join/leave, archive,
add/remove-member, against local PostgreSQL); `packages/daemon/test/agent-proxy.test.ts`'s new
validation/dispatch/404 cases; `packages/coforge/test/cli.test.ts` and
`channel-format.test.ts`.

This branch was reconciled with ADR 0025/#289 by merging `origin/main`, generalizing
`PublicChannels.members`/`addMembers` as described above, and rewriting the affected assertions
in `public-channel.integration.ts` (both this record's own scenario and #289's "channel members
add humans and Agents" scenario now pass together, in the same file, against local PostgreSQL).

The Raft-parity review added: `packages/coforge/test/channel-format.test.ts` was rewritten for
every renderer's new exact text/signature; `packages/coforge/test/cli.test.ts` gained a target-
validation test (`INVALID_TARGET` on `join`/`leave`/`update`/`lifecycle`/`add-member`/
`remove-member`, `info`/`members` unaffected) and its one existing `channel join` dispatch
assertion now expects the full Raft-parity text; `packages/coforge/test/local-client.test.ts`
gained three `channel()` cases (`NOT_FOUND` mapping on a target operation's `404`, no remapping
on `info`'s `404`, and a passthrough success case); `packages/daemon/test/daemon-connection.test.ts`
gained four cases covering `defaultAgentChannelHttpClient`'s `AgentTransportError` classification
(`404`, a network failure, a `2xx` passthrough) and the same classification reached through
`DaemonConnection.agentChannel`; `apps/web/test/agent-channel-management-routes-http.test.ts`'s
join/leave/add-member/remove-member fakes and assertions now carry the new booleans; and
`public-channel.integration.ts`'s "Agent channel management" scenario gained explicit
`alreadyJoined`/`wasMember`/`alreadyMember` assertions plus a DM-lookup-does-not-create-a-DM
assertion (asserting the `404` and that no DM conversation row was created), followed by a
success case once a DM conversation is seeded the same way a real `send`/`read` would create one.

Rollback is reverting the CR before merge. Post-merge, the safest rollback is a follow-up CR that
removes the new routes/CLI surface and stops writing `leftAt`/`archivedAt`/`role`; the columns
themselves are additive and default-backed, so no migration needs to run in reverse for existing
rows to keep working under the old code.
