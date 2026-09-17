# ADR 0031: Channel leave and member removal (human side)

Status: accepted
Date: 2026-09-17

## Context

ADR 0025 recorded Slack's default rules for public-channel membership (creation and
`addMembers` are open to any Workspace member/channel member respectively) and deferred
channel member removal as a "planned, not implemented" rule, blocked at the time on
`ConversationMember` rows being undeletable once they owned a `Message` or `Task`
(`onDelete: Restrict`). ADR 0024 (this branch is stacked on it) resolved that blocker for the
Agent CLI side: it added `ConversationMember.leftAt` as a soft-leave marker,
`ACTIVE_MEMBER_WHERE` as the one predicate every "is this Agent/human currently a member" query
uses, and implemented `AgentChannelManagement.leave`/`removeMember` for Agents (`Agent.role`
admin authority for `removeMember`, and `leave` never on `#general`).

This record is the human/Web-side equivalent: a Workspace human can leave a public channel
themselves, and a Workspace owner/admin can remove a human or an Agent from a public channel,
using the same `leftAt` representation and the same `ACTIVE_MEMBER_WHERE` predicate ADR 0024
already established — not a second representation.

Sources (fetched 2026-09-17; the product owner's original citation for `Leave a channel`,
`https://slack.com/help/articles/205240127-Leave-a-channel`, redirects to an unrelated
"mentions" article — the correct, current URL is `201375146`, used below):

- ["By default, Workspace Owners and Admins can remove people from public channels … It's not
  possible to remove people from the #general … channel."](https://slack.com/help/articles/201898668-Remove-someone-from-a-channel)
- ["No one can leave the general channel."](https://slack.com/help/articles/201375146-Leave-a-channel)
  (same page: "you can leave it at any time" for an ordinary channel; a Multi-Channel Guest
  "must be removed from public channels by an owner or admin" rather than leaving one
  themselves — CoForge has no guest role, so this last clause does not apply here.)

Neither source contradicts the rules below.

## Decision

1. **Remove.** `PublicChannels.removeMember(workspaceId, actorUserId, channelId, target:
   ChannelActor)` (`apps/web/src/server/conversations/public-channels.server.ts`) lets a
   Workspace owner/admin remove a human or an Agent from any public channel. Authority is the
   new `assertCanRemoveChannelMembers(role)` in
   `apps/web/src/server/workspaces/member-role.server.ts`, built on the existing `isAdminLike`
   (the same pattern as `assertCanCreateAgents`), checked via `workspaceMemberRole`
   (`members.server.ts`). Nobody — not even an owner — may be removed from `#general`
   (`AppError("CONFLICT")`), matching Slack. A plain `member` actor is denied
   `AppError("ACCESS_DENIED")` before any row is touched.
2. **Leave.** `PublicChannels.leave(workspaceId, userId, channelId)` lets any active human member
   leave a public channel themselves, except `#general` (`CONFLICT`). A human who is not
   currently an active member of the channel (never joined, or already left) is denied
   `ACCESS_DENIED`.
3. **Rejoin.** Unchanged from ADR 0024: a removed/departed human rejoins via the existing `join`
   (already an upsert that clears `leftAt`); an Agent needs a channel member to add it back via
   `addMembers` (also already an upsert). Both keep the same `ConversationMember` row, so mute
   preference and read boundary (`agentReadThroughSequence`/`ThreadRead`) survive a later
   rejoin — asserted in the integration test below (same member row id, `channelMuted` preserved
   across leave → rejoin).
4. **Shared write path.** Both `leave` and `removeMember`, on the human side, and
   `AgentChannelManagement.leave`/`removeMember`, on the Agent side, perform the identical
   write — set `leftAt` on one active row, matched by `{ userId }` or `{ agentId }` — so this
   record extracts it into one shared private-module helper, `softLeaveMember(db, conversationId,
   actor: ChannelActor)` in `public-channels.server.ts`, rather than four copies of the same
   `updateMany`. `AgentChannelManagement`'s own two methods now call this helper internally; its
   public behavior, return shapes, and error texts are unchanged (verified by the existing
   `public-channel.integration.ts` "Agent channel management" scenario, which still passes
   unmodified).
5. **Active membership everywhere, human side.** Auditing every human-scoped membership read
   found two gaps this record fixes as part of the same "leave stops delivery/posting" claim ADR
   0024 already made:
   - `PublicChannels.open`'s own-member lookup used `findUnique` on the raw
     `(conversationId, userId)` row instead of filtering `ACTIVE_MEMBER_WHERE`. A removed/left
     human therefore still saw `senderMemberId` populated (as if still an active member) instead
     of the read-only "not joined" preview the UI already has for someone who never joined. Fixed
     to `findFirst` with `ACTIVE_MEMBER_WHERE`, so leaving now flips the same UI state joining
     never happening does.
   - `PublicChannels.setUserThreadFollowed`'s member lookup had the same gap: a removed/left
     human could still follow (and be notified for) a thread. Fixed the same way.
   `PublicChannels.send` and `PublicChannels.setUserMuted` already filtered correctly (send
   denies with `ACCESS_DENIED`; a left member cannot be muted). Agent-side delivery
   (`AgentMessageDelivery` creation in `send`'s recipients query) and `getAgentChannel` already
   filtered through `ACTIVE_MEMBER_WHERE` from ADR 0024 and needed no change; this record adds an
   integration assertion that a removed Agent receives no delivery for a message sent afterward
   and that `getAgentChannel` denies it until re-added.
6. **`members()` gains two viewer-scoped booleans**, alongside the existing `canAddMembers`:
   `canRemoveMembers` (the actor is Workspace owner/admin — independent of whether the actor is
   themselves a member of *this* channel — and the channel is not `#general`) and `canLeave` (the
   actor is an active member of *this* channel and it is not `#general`). Both are computed for
   either actor kind (`{ userId }` or `{ agentId }`); the Agent CLI ignores them today (it has its
   own authority path via `Agent.role`), but the field is honest for both.
7. **Archived channels.** Leaving and removing are both still allowed on an archived channel,
   matching ADR 0024's decision that only the write paths that create new content (`send`,
   `join`) check `archivedAt`; no new archive behavior is introduced here.
8. **Action card `channel:create` now persists its description.** ADR 0027 point 8 recorded a
   known gap: `Conversation.description` did not exist yet when action cards shipped, so the
   Agent-proposed description was shown on the card but never passed to `PublicChannels.create`.
   ADR 0024 (this branch's base) added the column. This record closes the gap: `create` gained an
   optional trailing `description?: string` parameter, and
   `ActionCards.commitChannelCreate` now reads `payload.description` from the card's own already-
   resolved payload (added `payload: true` to `loadPendingCard`'s select) and passes it through.
   No card-contract change. `visibility: "private"` remains rejected at prepare time, unchanged.

## Rejected alternatives

- **A second soft-leave representation for the human path** (e.g. a separate `removedAt` or a
  join table): rejected — ADR 0024 already established `leftAt`/`ACTIVE_MEMBER_WHERE` as the one
  representation, and the human and Agent paths must stay indistinguishable to every membership
  query listed in ADR 0024's sweep.
- **Letting an owner/admin remove themselves via `removeMember`** with a self-removal exception
  (mirroring the Agent CLI's self-removal-needs-no-admin-authority behavior for `leave`):
  rejected for the human UI specifically — a human removes *others*; removing yourself is
  `leave`, which needs no admin authority and is already the separate, simpler action. The server
  method does not special-case `target` matching `actorUserId`; nothing prevents an admin from
  technically calling `removeMember` on themselves (Slack does not forbid this either), but the UI
  never offers it this way.
- **Gating `leave`/`removeMember` on `archivedAt`**: rejected, matching ADR 0024's own reasoning
  for `info`/`members` — an archived channel stays inspectable and its roster stays manageable;
  only content-creating writes are blocked.

## Consequences

- `apps/web`: no schema change (`leftAt`/`archivedAt`/`description` all already exist from ADR
  0024). `PublicChannels` gains `leave`, `removeMember`, and the shared `softLeaveMember` helper;
  `members()`'s return shape gains `canRemoveMembers`/`canLeave` (additive — no existing caller
  reads a narrower type that would break). `create()` gains an optional trailing parameter
  (additive; every existing call site is positional and unaffected).
- `member-role.server.ts` gains `assertCanRemoveChannelMembers`, covered by a new case in
  `workspace-member-role.test.ts`.
- `channels.functions.ts` gains `leavePublicChannel`/`removePublicChannelMember` Server
  Functions, both `workspaceUserMiddleware`-gated.
- UI: `ChannelMembersDialog` gains a per-row "Remove" action (owner/admin, not `#general`, inline
  confirm, no toast/`confirm()`) and a "Leave channel" footer action (active member, not
  `#general`, same inline-confirm pattern). After leaving, the conversation flips to the existing
  not-joined read-only state and the channel list reflects `joined: false` — no new UI states were
  invented; leaving now reaches the same code paths joining-never-happened already reaches (point
  5 above).
- `docs/architecture.md` §6.4 and `apps/web/AGENTS.md` updated in the same change to describe
  `leave`/`removeMember` and drop the "not implemented" wording; ADR 0025 point 3 is superseded by
  this record for the human side (ADR 0024 already superseded it for the Agent side); both link
  here.
- No Agent CLI change: `AgentChannelManagement`'s public behavior and error texts are unchanged,
  verified by rerunning its existing integration scenario unmodified.

## Validation and rollback

- `apps/web/test/workspace-member-role.test.ts`: `assertCanRemoveChannelMembers` (owner/admin
  allowed, member denied).
- `apps/web/test/public-channel.integration.ts`, new scenario "channel leave and member removal":
  owner/admin removes a human and an Agent (row keeps `leftAt`, message stays, roster excludes
  them, candidates include them again, `wasMember: false` on a repeat removal); a plain member is
  denied `ACCESS_DENIED`; nobody may leave or be removed from `#general` (`CONFLICT`, both
  directions); a member leaves, then cannot send or follow a thread, then rejoins via `join` and
  can send again with the same member row id and mute preference preserved; a removed Agent gets
  no `AgentMessageDelivery` for a later message and `getAgentChannel` denies it until re-added,
  at which point `addMembers` clears `leftAt` and delivery resumes; `members()`'s
  `canRemoveMembers`/`canLeave` reflect role, active membership, and the `#general` exemption.
  The existing "Agent channel management" scenario in the same file passes unmodified, confirming
  the shared `softLeaveMember` extraction did not change Agent-side behavior.
- `apps/web/test/action-cards.integration.ts`: the existing "commit channel:create" test extended
  to assert the created `Conversation.description` matches the card's proposed description.
- Manual verification: see the PR report for the exact steps and outcome (repository policy
  forbids new UI unit tests; `docs/agents/testing.md`'s manual verification Todo list applies).
- Rollback is reverting `PublicChannels.leave`/`removeMember`/`softLeaveMember`, the two Server
  Functions, `assertCanRemoveChannelMembers`, the `members()` field additions, the `create()`
  parameter, the `commitChannelCreate` description passthrough, and the UI; no schema or data
  migration to undo (nothing here added a column).

## Supersession

This record supersedes ADR 0025 §3's "not implemented" note for the **human** side (ADR 0024
already superseded it for the Agent side on 2026-09-17, the same day). ADR 0025 is not rewritten;
this note and ADR 0024's own supersession note are the links both ways.
