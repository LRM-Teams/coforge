# ADR 0025: Workspace owner/admin authority for channel and Agent creation

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
way. Raft's server-role model is the reference for *which actions require
admin authority*; CoForge does not adopt Raft's server-role vocabulary and
keeps its own Workspace `owner | admin | member` roles as the enforcement
mechanism.

This ADR is steps 1 and 2 of aligning with that model, human side only: no
Agent CLI/API channel commands, no action cards, no private channels, and no
new channel-level role system.

## Decision

1. Creating a public channel (`PublicChannels.create`) requires the actor's
   Workspace role to be `owner` or `admin`, enforced by
   `assertCanManageChannels` in `member-role.server.ts`. Joining a channel
   (`PublicChannels.join`) stays open to any Workspace member.
2. Owner/admin may add existing Workspace humans and Agents to any public
   channel via `PublicChannels.addMembers`, also gated by
   `assertCanManageChannels`. Any Workspace member may read a channel's
   member list and add-candidates via `PublicChannels.members`, because
   channels are already public within the Workspace. Membership alone still
   never creates attention (see §6.4): delivery eligibility is computed at
   message-send time from current membership and mute/mention/follow state,
   so adding a member requires no realtime or notification change.
3. Removing a channel member is **not implemented in this PR**. `Message.sender`
   references `ConversationMember` with `onDelete: Restrict` (confirmed in
   `prisma/schema.prisma`), so deleting a `ConversationMember` row that has
   ever sent a message in that channel would be rejected by PostgreSQL, and a
   member with no messages could still be removed inconsistently. Rather than
   ship a hard delete that silently fails for active members, this PR stays
   add-only; removal (and how to represent a departed member's message
   history) is a follow-up decision.
4. Creating an Agent (`ManageAgents.create`, called from
   `agents.functions.ts#createAgent`) requires the actor's Workspace role to
   be `owner` or `admin`, enforced by `assertCanCreateAgents` in
   `member-role.server.ts`. `assertCanManageChannels` and
   `assertCanCreateAgents` are separate named functions (both built on the
   existing `isAdminLike`) so each policy has one obvious place, even though
   today they apply the same rule.
5. `#general` keeps its existing auto-enrollment behavior for every Workspace
   human and Agent (§6.4); this ADR does not change it and does not add a way
   to remove someone from it.
6. Project discussion channels (`projects.functions.ts#createProject`) are
   created through a direct nested Prisma `conversations: { create: ... } }`
   write, not through `PublicChannels.create`, so they are unaffected by this
   decision and remain out of scope; project creation itself is unchanged.
7. UI: the "Create channel" action (Chat page header, Project detail page)
   and the "Create agent" action (Members/Agents page) are hidden for
   non-admins. A new "Members" utility button on the channel header opens
   `ChannelMembersDialog`, which lists current human/Agent members and, for
   owner/admin, an "Add members" checkbox list of Workspace candidates. UI
   gating is not a security boundary; the server functions re-enforce the
   same role checks.

## Rejected alternatives

- Copying Raft's server-role vocabulary (e.g. a separate "server admin"
  concept) instead of reusing Workspace `owner | admin | member`: rejected,
  ADR 0008 already established Workspace roles as CoForge's authority model
  and Raft's server-role model is only the reference for *what* requires
  admin authority, not *how* CoForge should name or store it.
- Introducing channel-level roles (owner/manager/member per channel):
  rejected, same as ADR 0008's original decision; Workspace roles are
  sufficient and channels stay public within a Workspace.
- Hard-deleting `ConversationMember` rows for channel removal in this PR:
  rejected because of the `Message.sender` `onDelete: Restrict` constraint
  described above; would need either an "left the channel" flag, orphaning
  history to a deleted-member placeholder, or a policy decision on message
  retention, none of which is decided yet.
- Adding Agent CLI `channel join/leave` commands or action cards in this PR:
  rejected as out of scope; this PR is the human/Web-side seam only, per the
  plan's steps 1 and 2.

## Consequences

- Existing `member`-role Workspace users lose the ability to create channels
  and Agents; only `owner`/`admin` retain that ability. No data migration is
  required since this only changes authorization, not persisted state.
- Project discussion channels continue to be created alongside their project
  by any project creator (unchanged, tracked as a separate follow-up should
  the same admin gate ever apply there).
- Agent CLI channel commands, action cards, private channels, and channel
  member removal remain open follow-ups; standing instructions must not claim
  or emulate them ahead of an implementation.
- `docs/architecture.md` §6.4 is updated in the same change to reflect this
  decision and supersede the "任意现有真人成员可创建频道 / 频道层不另建角色
  体系 / 当前不新增非默认频道的 Agent 加入入口" wording; `apps/web/AGENTS.md`'s
  public-channels paragraph is updated to describe the new
  `members`/`addMembers` seam.

## Validation and rollback

- `apps/web/test/workspace-member-role.test.ts` covers `assertCanManageChannels`
  and `assertCanCreateAgents`.
- `apps/web/test/manage-agents.test.ts` covers a `member` principal being
  denied Agent creation and an `admin` principal succeeding.
- `apps/web/test/public-channel.integration.ts` covers: a `member` cannot
  create a channel while an `admin` can; an admin adding a human and an Agent
  to a non-general channel; the added human's `open` showing a
  `senderMemberId`; the added Agent being resolvable by `getAgentChannel` and
  receiving an `AgentMessageDelivery` when a human posts afterward; a
  `member` being denied `addMembers`; and invalid user/Agent ids being
  rejected with `INVALID_INPUT`.
- Rollback is reverting the authorization checks (`assertCanManageChannels`,
  `assertCanCreateAgents`) and the UI gating; no schema or data change to
  undo.
