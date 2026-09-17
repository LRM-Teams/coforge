# ADR 0025: Channel membership and Agent creation authority

Status: accepted
Date: 2026-09-17

## Context

CoForge's public-channel decision (§6.4 of `docs/architecture.md`, and the
earlier "任意现有真人成员可创建频道 / 频道层不另建角色体系 / 当前不新增非默认
频道的 Agent 加入入口" wording it recorded) let any existing Workspace human
create a channel, kept channels free of their own role system, and offered no
entry point to add an Agent to a non-default channel. ADR 0008 already gives
Workspace human membership an `owner | admin | member` role, used today for
member invitations and role changes (`member-role.server.ts`).

Raft Computer 1.0.32 (the reference build; see
`docs/agents/reference-cli-research.md`) gates the equivalent actions behind
its own server-role model: its daemon command help text describes creating a
public or private channel as an action available "when this agent has server
admin authority", and adding a human or agent to a regular channel the same
way. An earlier version of this ADR (accepted the same day) copied that
gate onto both channel creation and channel membership. The product owner
then reviewed that decision against Slack's defaults and asked CoForge to
follow Slack for channels instead, because CoForge plans to introduce private
channels and members need to be able to create them without an admin
gatekeeper:

- ["By default, members can create channels"](https://slack.com/help/articles/201402297-Create-a-channel)
- ["All members and Multi-Channel Guests"](https://slack.com/help/articles/201980108-Add-people-to-a-channel)
  can add people to channels
- ["By default, Workspace Owners and Admins can remove people from public
  channels … It's not possible to remove people from the #general or
  #all-companyname channel."](https://slack.com/help/articles/201898668-Remove-someone-from-a-channel)
  (removal is a **later** PR; this ADR only records the planned rule)

Agent creation is a different action: Raft only creates an agent from a
human-committed action card, never from Agent-initiated CLI/API activity.
CoForge already applies an equivalent authority gate to Agent creation
(`ManageAgents.create`) and the owner's review did not change that; it
stays owner/admin.

This ADR is steps 1 and 2 of aligning with Slack's channel defaults plus
Raft's Agent-creation authority, human side only: no Agent CLI/API channel
commands, no action cards, no private channels yet, and no new
channel-level role system.

## Decision

1. Creating a public channel (`PublicChannels.create`) requires only that
   the actor be a Workspace member — the existing membership check, no role
   gate. This matches Slack's default ("By default, members can create
   channels"). Joining a channel (`PublicChannels.join`) stays open to any
   Workspace member, unchanged.
2. A channel member adds existing Workspace humans and/or Agents to that
   channel via `PublicChannels.addMembers`; the actor must have a
   `ConversationMember` row in the target channel (Slack: "All members …
   can add people to channels" — you add people to channels you're in),
   enforced with `ACCESS_DENIED` otherwise. Any Workspace member may read a
   channel's member list and add-candidates via `PublicChannels.members`
   (`canAddMembers` reports whether the actor is a member of that specific
   channel), because channels are already public within the Workspace.
   Membership alone still never creates attention (see §6.4): delivery
   eligibility is computed at message-send time from current membership and
   mute/mention/follow state, so adding a member requires no realtime or
   notification change.
3. Removing a channel member is **not implemented in this PR**. **Superseded**:
   the Agent-CLI side is implemented by ADR 0024
   (`docs/adr/0024-agent-channel-management.md`, `channel remove-member`) and
   the human/Web side by ADR 0031
   (`docs/adr/0031-channel-leave-and-member-removal.md`,
   `PublicChannels.removeMember`/`leave`), both using the soft `leftAt`
   marker this point anticipated needing. `Message.sender`
   references `ConversationMember` with `onDelete: Restrict` (confirmed in
   `prisma/schema.prisma`), so deleting a `ConversationMember` row that has
   ever sent a message in that channel would be rejected by PostgreSQL, and a
   member with no messages could still be removed inconsistently. The planned
   rule, recorded here as a follow-up and not implemented, is Slack's: by
   default Workspace owner/admin may remove someone from a public channel,
   and it is never possible to remove someone from `#general` (CoForge's
   equivalent of Slack's `#general`/`#all-companyname`). The implementation
   will likely need a soft `leftAt` marker on `ConversationMember` rather
   than a hard delete, keeping that member's messages; the exact shape is
   deferred to that PR.
4. Creating an Agent (`ManageAgents.create`, called from
   `agents.functions.ts#createAgent`) still requires the actor's Workspace
   role to be `owner` or `admin`, enforced by `assertCanCreateAgents` in
   `member-role.server.ts`. This is unchanged by the owner's review: Raft
   only creates an agent from a human-committed action card, never from
   Agent-initiated activity, and CoForge keeps the equivalent authority gate.
   `assertCanCreateAgents` remains its own named function (built on the
   existing `isAdminLike`) so Agent creation has one obvious policy seam,
   independent from the now-ungated channel-creation path.
5. `#general` keeps its existing auto-enrollment behavior for every Workspace
   human and Agent (§6.4); this ADR does not change it and does not add a way
   to remove someone from it (see the planned removal rule above).
6. Project discussion channels (`projects.functions.ts#createProject`) are
   created through a direct nested Prisma `conversations: { create: ... } }`
   write, not through `PublicChannels.create`, so they are unaffected by this
   decision and remain out of scope; project creation itself is unchanged.
7. UI: the "Create channel" action (Chat page header, Project detail page)
   is unconditional again, matching any-member creation. The "Create agent"
   action (Members/Agents page) stays hidden for non-admins. The "Members"
   utility button on the channel header still opens `ChannelMembersDialog`,
   which lists current human/Agent members for any Workspace member and, for
   an actor who is a member of that channel, an "Add members" checkbox list
   of Workspace candidates (`canAddMembers`). UI gating is not a security
   boundary; the server functions re-enforce the same checks.

## Rejected alternatives

- Keeping the Raft-aligned owner/admin gate on channel creation and
  membership (this ADR's original, same-day decision): rejected after
  product review — CoForge plans private channels, and members must be able
  to create and populate them without waiting on an admin, matching Slack's
  defaults rather than Raft's server-admin model for this specific surface.
- Copying Raft's server-role vocabulary (e.g. a separate "server admin"
  concept) instead of reusing Workspace `owner | admin | member`: rejected,
  ADR 0008 already established Workspace roles as CoForge's authority model,
  and this remains the enforcement mechanism for the one authority gate that
  does stay (Agent creation).
- Introducing channel-level roles (owner/manager/member per channel):
  rejected, same as ADR 0008's original decision; Workspace roles are
  sufficient and channels stay public within a Workspace.
- Implementing channel member removal now: rejected, same blocker as
  before (`Message.sender` `onDelete: Restrict`) plus the added need to
  decide the soft-leave/message-retention shape; deferred to a follow-up PR
  that will implement Slack's owner/admin-remove-from-public-channels rule.
- Adding Agent CLI `channel join/leave` commands or action cards in this PR:
  rejected as out of scope; this PR is the human/Web-side seam only.

## Consequences

- Any Workspace member, including plain `member`, may create a channel and
  add people to channels they belong to; only Agent creation still requires
  `owner`/`admin`. No data migration is required since this only changes
  authorization, not persisted state.
- Project discussion channels continue to be created alongside their project
  by any project creator (unchanged, tracked as a separate follow-up should
  the same authority question ever apply there).
- Agent CLI channel commands, action cards, private channels, and channel
  member removal remain open follow-ups; standing instructions must not claim
  or emulate them ahead of an implementation. Channel member removal has a
  recorded planned rule (above) but no implementation.
- `docs/architecture.md` §6.4 is updated in the same change to reflect this
  decision and supersede the earlier owner/admin-gated wording;
  `apps/web/AGENTS.md`'s public-channels paragraph is updated to describe the
  membership-gated `addMembers` seam.

## Validation and rollback

- `apps/web/test/workspace-member-role.test.ts` covers `assertCanCreateAgents`
  (the manage-channels role-gate tests are removed along with
  `assertCanManageChannels`, which no longer exists).
- `apps/web/test/manage-agents.test.ts` covers a `member` principal being
  denied Agent creation and an `admin` principal succeeding (unchanged).
- `apps/web/test/public-channel.integration.ts` covers: a plain `member` can
  create a channel again; a Workspace member who is not a member of a given
  channel is denied `addMembers` with `ACCESS_DENIED` and sees
  `canAddMembers: false`; a channel member with a plain `member` Workspace
  role can add a human and an Agent to that channel; invalid user/Agent ids
  are rejected with `INVALID_INPUT`.
- Rollback is reverting the authorization checks
  (`PublicChannels.create`'s membership-only check back to a role gate,
  `PublicChannels.addMembers`'s membership check back to a role gate) and the
  UI gating; no schema or data change to undo.
