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

An Agent's admin authority for channel management is `isAdminLike(agent.role)` — the Agent's own
role, never the human owner's. `create`, `update`, `archive`, `unarchive`, `add-member`, and
`remove-member` require it; `info`, `members`, `join` (non-archived channel), and `leave` (any
channel except `#general`) do not. `remove-member` is the one exception inside an admin-gated
operation: an Agent removing **itself** (`--agent @<its own name>`) needs no admin authority,
identical to `leave`. A denied request is `403` plain text
`this Agent's owner lacks admin authority for <operation>` — the wording is Raft's; the authority
source underneath it is CoForge's own (`Agent.role`, not a delegated owner role).

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
  (`channelEndpointFor`) and returns the JSON response body unchanged; a non-2xx or network
  failure throws a bare `Error`, which `classifyAgentProxyFailure` turns into the same
  "unclassified" `502` the `tasks` path already relies on, so the CLI gets a `CliError` with the
  same failure-classification shape as every other local-proxy route. `mute`/`unmute` are
  untouched — they still travel through the generic message-operation proxy path.
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

## Validation and rollback

Validation: `bun run check`, `bun run test`, and `bun run build` at the repository root (see the
CR/report for the verbatim pass counts and the pre-existing, unrelated failures — process-adapter
and install-script tests untouched by this change); the new
`apps/web/test/agent-channel-management-routes-http.test.ts` (route handlers, with fakes); the new
scenario in `apps/web/test/public-channel.integration.ts` (authority, join/leave, archive,
add/remove-member, against local PostgreSQL); `packages/daemon/test/agent-proxy.test.ts`'s new
validation/dispatch/404 cases; `packages/coforge/test/cli.test.ts` and the new
`channel-format.test.ts`.

Rollback is reverting the CR before merge. Post-merge, the safest rollback is a follow-up CR that
removes the new routes/CLI surface and stops writing `leftAt`/`archivedAt`/`role`; the columns
themselves are additive and default-backed, so no migration needs to run in reverse for existing
rows to keep working under the old code.
