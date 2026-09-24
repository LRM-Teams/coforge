import type { Conversation, PrismaClient } from "#src/generated/prisma/client";
import { isAppError } from "#src/lib/app-error";
import { ACTIVE_MEMBER_WHERE } from "./active-member.server";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { AGENT_VISIBILITY } from "#src/features/agents/agent-visibility";
import {
  agentVisibilityViewerForActor,
  canSeeAgent,
} from "#src/server/agents/agent-visibility.server";
import {
  AgentChannelManagementError,
  channelAuthorityDeniedError,
} from "./agent-channel-management-error.server";
import { PublicChannels } from "./public-channels.server";
import { announceMemberChanged, type ConversationRealtime } from "./conversation-realtime.server";
import {
  hasChannelAdminAuthority,
  resolveChannelAuthority,
  type ChannelAdminBasis,
  type ChannelCapabilities,
} from "./channel-authority.server";
import { resolveAgentChannelStatus } from "#src/server/agents/agent-channel-status.server";
import { getAgentDisplay, type AgentDisplay } from "#src/server/agents/agent-display.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { AgentInboxPurgePublisher } from "#src/server/agents/agent-inbox-purge.server";

const CHANNEL_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const CHANNEL_TARGET = /^#[a-z0-9][a-z0-9_-]{0,31}$/;
const USER_TARGET = /^@[a-z0-9][a-z0-9_-]{0,31}$/;
const MEMBER_HANDLE = /^@[a-z0-9][a-z0-9_-]{0,31}$/;

export type AgentChannelInfo = {
  id: string;
  name: string;
  description: string;
  archived: boolean;
  joined: boolean;
  muted: boolean;
  memberCounts: { agents: number; humans: number };
  /** Present only when the acting Agent is currently an active member (its stored
   * `ConversationMember.channelRole`); absent for a non-member, matching Raft's
   * "each part only when present". */
  channelRole?: string;
  /** Present only when the acting Agent has channel-admin authority on this channel — either
   * basis. */
  channelAdminBasis?: ChannelAdminBasis;
  /** Every capability name; only the ones this Agent may currently invoke are `true`. */
  channelCapabilities: ChannelCapabilities;
  /** Present only when this channel is a Project discussion group for a Project the
   * Agent's own Workspace owns. Field names and source match `workspace info --projects`
   * (`WorkspaceInfoProject` in `@lrm/coforge-sdk`), so an Agent can match the two surfaces up. */
  project?: {
    id: string;
    name: string;
    slug: string;
    githubFullName?: string;
    githubHtmlUrl?: string;
  };
};

export type AgentChannelRoster = {
  target: string;
  // `channelRole`/`channelAdminBasis` are present for a `#channel` roster (every listed member
  // is an active member there) and absent for the `@user` DM roster, which has no channel-role
  // concept at all.
  agents: Array<{
    name: string;
    displayName: string;
    description: string;
    serverRole: string;
    channelRole?: string;
    channelAdminBasis?: ChannelAdminBasis;
    self: boolean;
    status: "online" | "offline" | "unknown";
    activity?: string;
    activityDetail?: string;
  }>;
  humans: Array<{
    username: string;
    serverRole: string;
    channelRole?: string;
    channelAdminBasis?: ChannelAdminBasis;
  }>;
};

export type AgentChannelMemberInput = { user?: string; agent?: string };

/** The seam route handlers depend on, so unit tests can supply a fake instead of Prisma. */
export type AgentChannelManagementRepository = Pick<
  AgentChannelManagement,
  | "info"
  | "members"
  | "join"
  | "leave"
  | "create"
  | "update"
  | "setArchived"
  | "addMember"
  | "removeMember"
>;

/**
 * Agent-facing channel lifecycle and roster management. Every read/write here is scoped by
 * Workspace and, where the operation targets a specific member, filtered through
 * `ACTIVE_MEMBER_WHERE` so a soft-left member never counts as present, joined, or listed.
 */
export class AgentChannelManagement {
  private readonly channels: PublicChannels;
  private readonly inboxPurge: Pick<AgentInboxPurgePublisher, "purge">;

  constructor(
    private readonly db: PrismaClient,
    private readonly display?: Pick<AgentDisplay, "snapshot">,
    channels?: PublicChannels,
    // The whole port, not just `memberChanged`: it is also the default `PublicChannels`'.
    private readonly realtime?: ConversationRealtime,
    inboxPurge?: Pick<AgentInboxPurgePublisher, "purge">,
  ) {
    this.inboxPurge = inboxPurge ?? new AgentInboxPurgePublisher(db);
    // Reused (not reimplemented) so the human "Members" dialog and the Agent CLI's
    // `channel members`/`add-member` cannot drift.
    this.channels =
      channels ??
      new PublicChannels(db, undefined, undefined, undefined, realtime, this.inboxPurge);
  }

  async info(workspaceId: string, agentId: string, target: string): Promise<AgentChannelInfo> {
    const channelName = this.parseChannelTarget(target);
    const channel = await this.findChannel(workspaceId, channelName);
    return this.channelInfo(workspaceId, channel, agentId);
  }

  async members(workspaceId: string, agentId: string, target: string): Promise<AgentChannelRoster> {
    const parentTarget = target.split(":")[0] ?? "";
    if (parentTarget.startsWith("#")) {
      const channelName = this.parseChannelTarget(parentTarget);
      const channel = await this.findChannel(workspaceId, channelName);
      const raw = await this.channels.members(workspaceId, { agentId }, channel.id);
      return this.shapeAgentRoster(workspaceId, agentId, `#${channel.channelName}`, raw);
    }
    if (!USER_TARGET.test(parentTarget))
      throw new AgentChannelManagementError(400, "target must be a #channel or @user");
    const username = parentTarget.slice(1);
    const user = await this.db.user.findUnique({ where: { username }, select: { id: true } });
    if (!user) throw new AgentChannelManagementError(404, "channel not found");
    // Look up only: inspecting who could message in a DM must not have the side effect of
    // starting one (unlike `read`/`search`/`send`, which lazily create it).
    const conversation = await new PrismaDirectConversationRepository(
      this.db,
    ).findUserAgentConversation(workspaceId, user.id, agentId);
    if (!conversation) throw new AgentChannelManagementError(404, "channel not found");
    return this.roster(workspaceId, conversation.id, agentId, parentTarget);
  }

  async join(workspaceId: string, agentId: string, target: string) {
    const channelName = this.parseChannelTarget(target);
    const channel = await this.findChannel(workspaceId, channelName);
    if (channel.archivedAt) throw new AgentChannelManagementError(409, "channel is archived");
    await this.assertCallerNotPrivate(workspaceId, agentId, "join");
    const existing = await this.db.conversationMember.findFirst({
      where: { conversationId: channel.id, agentId, ...ACTIVE_MEMBER_WHERE },
      select: { id: true },
    });
    await this.db.conversationMember.upsert({
      where: { conversationId_agentId: { conversationId: channel.id, agentId } },
      create: { conversationId: channel.id, workspaceId, agentId },
      update: { leftAt: null },
    });
    if (!existing)
      await announceMemberChanged(this.realtime, { workspaceId, conversationIds: [channel.id] });
    return { target: `#${channel.channelName}`, joined: true, alreadyJoined: Boolean(existing) };
  }

  async leave(workspaceId: string, agentId: string, target: string) {
    const channelName = this.parseChannelTarget(target);
    // Looked up first: a #general hidden from the Workspace is an unknown channel, not a refusal.
    const channel = await this.findChannel(workspaceId, channelName);
    if (channelName === "general")
      throw new AgentChannelManagementError(400, "cannot leave #general");
    const result = await this.db.conversationMember.updateMany({
      where: { conversationId: channel.id, agentId, ...ACTIVE_MEMBER_WHERE },
      data: { leftAt: new Date() },
    });
    if (result.count > 0) {
      await announceMemberChanged(this.realtime, { workspaceId, conversationIds: [channel.id] });
      await this.inboxPurge.purge({
        workspaceId,
        agentId,
        conversationIds: [channel.id],
        reason: "left",
      });
    }
    return { target: `#${channel.channelName}`, joined: false, wasMember: result.count > 0 };
  }

  async create(
    workspaceId: string,
    agentId: string,
    rawName: string,
    description: string | undefined,
  ) {
    // Slack's default: any Agent that belongs to the Workspace may create a
    // channel, the same as `PublicChannels.create` for humans — no admin gate.
    const agent = await this.db.agent.findFirst({
      where: { id: agentId, workspaceId },
      select: { id: true },
    });
    if (!agent)
      throw new AgentChannelManagementError(403, "this Agent does not belong to the Workspace");
    await this.assertCallerNotPrivate(workspaceId, agentId, "create");
    const name = this.normalizeChannelName(rawName);
    if (name === "general") throw new AgentChannelManagementError(409, "general is reserved");
    try {
      const channel = await this.db.conversation.create({
        data: {
          workspaceId,
          channelName: name,
          description: description ?? "",
          // The creator becomes the channel's first admin, same as a human creator.
          members: { create: { agentId, channelRole: "admin" } },
        },
      });
      return {
        target: `#${channel.channelName}`,
        channel: {
          id: channel.id,
          name: `#${channel.channelName}`,
          description: channel.description,
        },
      };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "P2002")
        throw new AgentChannelManagementError(409, "channel name is already in use");
      throw error;
    }
  }

  async update(
    workspaceId: string,
    agentId: string,
    target: string,
    patch: { name?: string; description?: string },
  ): Promise<AgentChannelInfo> {
    if (patch.name === undefined && patch.description === undefined)
      throw new AgentChannelManagementError(400, "update requires --name or --description");
    const channelName = this.parseChannelTarget(target);
    const channel = await this.findChannel(workspaceId, channelName);
    // Authority before the input is judged, so an Agent without it learns nothing else.
    if (!(await hasChannelAdminAuthority(this.db, workspaceId, { agentId }, channel)))
      throw channelAuthorityDeniedError("update");
    if (channel.archivedAt) throw new AgentChannelManagementError(409, "channel is archived");
    let nextName: string | undefined;
    if (patch.name !== undefined) {
      if (channelName === "general")
        throw new AgentChannelManagementError(400, "cannot rename #general");
      nextName = this.normalizeChannelName(patch.name);
      if (nextName === "general") throw new AgentChannelManagementError(409, "general is reserved");
    }
    // Shared with the human settings panel, which applies the same authority and archive rules.
    try {
      await this.channels.updateInfo(workspaceId, { agentId }, channel.id, {
        name: nextName,
        description: patch.description,
      });
    } catch (error) {
      if (isAppError(error) && error.code === "ACCESS_DENIED")
        throw channelAuthorityDeniedError("update");
      if (isAppError(error) && error.code === "CONFLICT")
        throw new AgentChannelManagementError(409, "channel name is already in use");
      throw error;
    }
    return this.channelInfo(
      workspaceId,
      await this.findChannel(workspaceId, nextName ?? channelName),
      agentId,
    );
  }

  async setArchived(workspaceId: string, agentId: string, target: string, archived: boolean) {
    const operation = archived ? "archive" : "unarchive";
    const channelName = this.parseChannelTarget(target);
    const channel = await this.findChannel(workspaceId, channelName);
    if (channelName === "general")
      throw new AgentChannelManagementError(400, `cannot ${operation} #general`);
    try {
      await this.channels.setArchived(workspaceId, { agentId }, channel.id, archived);
    } catch (error) {
      if (isAppError(error) && error.code === "ACCESS_DENIED")
        throw channelAuthorityDeniedError(operation);
      throw error;
    }
    return { target: `#${channel.channelName}`, archived };
  }

  /**
   * Slack rule: the acting Agent must itself be an active member of the target
   * channel — enforced inside `PublicChannels.addMembers`, not re-implemented here. This method
   * only resolves the `@handle` to an id (so a genuinely unknown handle is a 404, distinct from
   * a real Workspace member/Agent the actor isn't allowed to add-through) and reshapes the
   * response for the CLI.
   */
  async addMember(
    workspaceId: string,
    callingAgentId: string,
    target: string,
    input: AgentChannelMemberInput,
  ) {
    const channelName = this.parseChannelTarget(target);
    const { kind, handle } = this.parseMemberInput(input);
    const channel = await this.findChannel(workspaceId, channelName);
    let userId: string | undefined;
    let resolvedAgentId: string | undefined;
    if (kind === "user") {
      const user = await this.db.user.findUnique({
        where: { username: handle },
        select: { id: true },
      });
      if (!user) throw new AgentChannelManagementError(404, `member not found: @${handle}`);
      userId = user.id;
    } else {
      const agentRow = await this.db.agent.findFirst({
        where: { workspaceId, name: handle, ...ACTIVE_AGENT_WHERE },
        select: { id: true, ownerId: true, visibility: true },
      });
      if (!agentRow) throw new AgentChannelManagementError(404, `member not found: @${handle}`);
      // A private Agent the calling Agent cannot see answers the stable
      // `agent_not_visible` outcome with an explanation, distinct from a genuinely nonexistent
      // handle's plain "member not found" — the same distinction `user info`/`profile show`
      // make. A private Agent the caller CAN see (its own creator, or an owner/admin) still
      // cannot be added to any channel; `PublicChannels.addMembers` below is the unconditional
      // enforcement, but rejecting it here with a clear reason avoids a confusing generic error
      // for a target the caller already knows exists.
      const viewer = await agentVisibilityViewerForActor(this.db, workspaceId, {
        agentId: callingAgentId,
      });
      if (!canSeeAgent(viewer, agentRow))
        throw new AgentChannelManagementError(
          404,
          `@${handle} is not visible to you.`,
          "agent_not_visible",
        );
      if (agentRow.visibility !== AGENT_VISIBILITY.PUBLIC)
        throw new AgentChannelManagementError(
          400,
          `@${handle} is private and cannot be added to a channel`,
        );
      resolvedAgentId = agentRow.id;
    }
    let alreadyMember = false;
    try {
      const result = await this.channels.addMembers(
        workspaceId,
        { agentId: callingAgentId },
        channel.id,
        {
          userIds: userId ? [userId] : [],
          agentIds: resolvedAgentId ? [resolvedAgentId] : [],
        },
      );
      alreadyMember = userId
        ? result.alreadyMemberUserIds.includes(userId)
        : result.alreadyMemberAgentIds.includes(resolvedAgentId!);
    } catch (error) {
      if (isAppError(error) && error.code === "ACCESS_DENIED")
        throw new AgentChannelManagementError(
          403,
          `this Agent must be a member of #${channel.channelName} to add members to it`,
        );
      if (isAppError(error) && (error.code === "INVALID_INPUT" || error.code === "NOT_FOUND"))
        throw new AgentChannelManagementError(404, `member not found: @${handle}`);
      if (isAppError(error) && error.code === "CONFLICT")
        throw new AgentChannelManagementError(409, "channel is archived");
      throw error;
    }
    return {
      target: `#${channel.channelName}`,
      member: { kind, handle: `@${handle}` },
      added: true as const,
      alreadyMember,
    };
  }

  async removeMember(
    workspaceId: string,
    callingAgentId: string,
    target: string,
    input: AgentChannelMemberInput,
  ) {
    const channelName = this.parseChannelTarget(target);
    const { kind, handle } = this.parseMemberInput(input);
    const channel = await this.findChannel(workspaceId, channelName);
    if (channelName === "general")
      throw new AgentChannelManagementError(400, "cannot remove a member from #general");
    let wasMember: boolean;
    let removedAgentId: string | undefined;
    if (kind === "agent") {
      const agentRow = await this.db.agent.findFirst({
        where: { workspaceId, name: handle },
        select: { id: true },
      });
      if (!agentRow) throw new AgentChannelManagementError(404, `member not found: @${handle}`);
      const isSelf = agentRow.id === callingAgentId;
      if (
        !isSelf &&
        !(await hasChannelAdminAuthority(
          this.db,
          workspaceId,
          { agentId: callingAgentId },
          channel,
        ))
      )
        throw channelAuthorityDeniedError("remove-member");
      const result = await this.db.conversationMember.updateMany({
        where: { conversationId: channel.id, agentId: agentRow.id, ...ACTIVE_MEMBER_WHERE },
        data: { leftAt: new Date() },
      });
      wasMember = result.count > 0;
      if (wasMember) removedAgentId = agentRow.id;
    } else {
      if (
        !(await hasChannelAdminAuthority(
          this.db,
          workspaceId,
          { agentId: callingAgentId },
          channel,
        ))
      )
        throw channelAuthorityDeniedError("remove-member");
      const user = await this.db.user.findUnique({ where: { username: handle } });
      if (!user) throw new AgentChannelManagementError(404, `member not found: @${handle}`);
      const result = await this.db.conversationMember.updateMany({
        where: { conversationId: channel.id, userId: user.id, ...ACTIVE_MEMBER_WHERE },
        data: { leftAt: new Date() },
      });
      wasMember = result.count > 0;
    }
    if (wasMember)
      await announceMemberChanged(this.realtime, { workspaceId, conversationIds: [channel.id] });
    if (removedAgentId)
      await this.inboxPurge.purge({
        workspaceId,
        agentId: removedAgentId,
        conversationIds: [channel.id],
        reason: "member_removed",
      });
    return { target: `#${channel.channelName}`, removed: true as const, wasMember };
  }

  /** A private Agent can neither join nor create a channel — the acting Agent's OWN
   * visibility, independent of any target. Reused by `join()` and `create()`. */
  private async assertCallerNotPrivate(
    workspaceId: string,
    agentId: string,
    operation: "join" | "create",
  ): Promise<void> {
    const agent = await this.db.agent.findFirst({
      where: { id: agentId, workspaceId, ...ACTIVE_AGENT_WHERE },
      select: { visibility: true },
    });
    if (!agent || agent.visibility !== AGENT_VISIBILITY.PUBLIC)
      throw new AgentChannelManagementError(403, `a private Agent cannot ${operation} a channel`);
  }

  private async findChannel(workspaceId: string, channelName: string): Promise<Conversation> {
    const channel = await this.db.conversation.findUnique({
      where: { workspaceId_channelName: { workspaceId, channelName } },
    });
    // A channel hidden from the Workspace is an unknown channel to an Agent.
    if (!channel || channel.hiddenFromWorkspaceAt)
      throw new AgentChannelManagementError(404, "channel not found");
    return channel;
  }

  private async channelInfo(
    workspaceId: string,
    channel: Pick<Conversation, "id" | "channelName" | "description" | "archivedAt" | "projectId">,
    agentId: string,
  ): Promise<AgentChannelInfo> {
    const [member, memberCounts, authority, project] = await Promise.all([
      this.db.conversationMember.findFirst({
        where: { conversationId: channel.id, agentId, ...ACTIVE_MEMBER_WHERE },
        select: { channelMuted: true },
      }),
      this.memberCounts(channel.id),
      resolveChannelAuthority(this.db, workspaceId, { agentId }, channel),
      this.channelProject(workspaceId, channel.projectId),
    ]);
    return {
      id: channel.id,
      name: `#${channel.channelName}`,
      description: channel.description,
      archived: channel.archivedAt !== null,
      joined: Boolean(member),
      muted: member?.channelMuted ?? false,
      memberCounts,
      channelRole: authority.channelRole,
      channelAdminBasis: authority.adminBasis,
      channelCapabilities: authority.capabilities,
      ...(project ? { project } : {}),
    };
  }

  /** Resolves a channel's bound Project, scoped to the caller's own Workspace so a `projectId`
   * that somehow points outside it (never a case reachable through `PublicChannels.create`'s own
   * Workspace check, but not otherwise enforced at the database level) can never leak another
   * Workspace's Project name, slug, or GitHub binding. */
  private async channelProject(
    workspaceId: string,
    projectId: string | null,
  ): Promise<AgentChannelInfo["project"]> {
    if (!projectId) return undefined;
    const project = await this.db.project.findFirst({
      where: { id: projectId, workspaceId },
      select: { id: true, name: true, slug: true, githubFullName: true, githubHtmlUrl: true },
    });
    if (!project) return undefined;
    return {
      id: project.id,
      name: project.name,
      slug: project.slug,
      ...(project.githubFullName ? { githubFullName: project.githubFullName } : {}),
      ...(project.githubHtmlUrl ? { githubHtmlUrl: project.githubHtmlUrl } : {}),
    };
  }

  private async memberCounts(conversationId: string) {
    const [agents, humans] = await Promise.all([
      this.db.conversationMember.count({
        where: { conversationId, agentId: { not: null }, ...ACTIVE_MEMBER_WHERE },
      }),
      this.db.conversationMember.count({
        where: { conversationId, userId: { not: null }, ...ACTIVE_MEMBER_WHERE },
      }),
    ]);
    return { agents, humans };
  }

  /** The `@user` DM roster: not a named channel, so `PublicChannels.members` (which requires
   * `channelName` set) does not apply; queried directly, then shaped the same way. */
  private async roster(
    workspaceId: string,
    conversationId: string,
    callingAgentId: string,
    target: string,
  ): Promise<AgentChannelRoster> {
    const rows = await this.db.conversationMember.findMany({
      where: { conversationId, ...ACTIVE_MEMBER_WHERE },
      select: {
        agentId: true,
        userId: true,
        agent: {
          select: {
            id: true,
            name: true,
            displayName: true,
            description: true,
            role: true,
            computerId: true,
          },
        },
        user: { select: { id: true, username: true } },
      },
    });
    const agentRows = rows.flatMap((row) => (row.agent ? [row.agent] : []));
    const humanRows = rows.flatMap((row) => (row.user ? [row.user] : []));
    const roles = humanRows.length
      ? await this.db.workspaceMembership.findMany({
          where: { workspaceId, userId: { in: humanRows.map((row) => row.id) } },
          select: { userId: true, role: true },
        })
      : [];
    const roleByUserId = new Map(roles.map((role) => [role.userId, role.role]));
    // A DM is not a named channel: there is no channel-role concept here, so `channelRole`/
    // `channelAdminBasis` stay unset for every entry (see `AgentChannelRoster`).
    return this.shapeAgentRoster(workspaceId, callingAgentId, target, {
      agents: agentRows.map((agent) => ({ ...agent, serverRole: agent.role })),
      humans: humanRows.map((row) => ({
        id: row.id,
        username: row.username,
        serverRole: roleByUserId.get(row.id) ?? "member",
      })),
    });
  }

  /**
   * Reshapes `PublicChannels.members`' (or the DM roster's) raw membership facts into the
   * Agent-facing response: role/self tags plus each Agent's live status
   * (`resolveAgentChannelStatus`). The only Agent-specific glue here is `self` and `status`/
   * `activity`/`activityDetail` — membership, roles, and authority all come from the shared data.
   */
  private async shapeAgentRoster(
    workspaceId: string,
    callingAgentId: string,
    target: string,
    raw: {
      agents: Array<{
        id: string;
        name: string;
        displayName: string;
        description: string;
        serverRole: string;
        channelRole?: string;
        channelAdminBasis?: ChannelAdminBasis;
        computerId: string | null;
      }>;
      humans: Array<{
        id: string;
        username: string;
        serverRole: string;
        channelRole?: string;
        channelAdminBasis?: ChannelAdminBasis;
      }>;
    },
  ): Promise<AgentChannelRoster> {
    const display = this.resolvedDisplay();
    const agents = await Promise.all(
      raw.agents.map(async (agent) => ({
        name: agent.name,
        displayName: agent.displayName,
        description: agent.description,
        serverRole: agent.serverRole,
        channelRole: agent.channelRole,
        channelAdminBasis: agent.channelAdminBasis,
        self: agent.id === callingAgentId,
        ...(await resolveAgentChannelStatus(display, {
          workspaceId,
          computerId: agent.computerId,
          agentId: agent.id,
        })),
      })),
    );
    return {
      target,
      agents: agents.sort((left, right) => left.name.localeCompare(right.name)),
      humans: raw.humans
        .map((human) => ({
          username: human.username,
          serverRole: human.serverRole,
          channelRole: human.channelRole,
          channelAdminBasis: human.channelAdminBasis,
        }))
        .sort((left, right) => left.username.localeCompare(right.username)),
    };
  }

  /** Deferred: constructing the real `AgentDisplay` throws when `REDIS_URL` is unset, and that
   * failure must be caught per-Agent (as "unknown") by `resolveAgentChannelStatus`, not thrown
   * out of the whole roster read. */
  private resolvedDisplay(): Pick<AgentDisplay, "snapshot"> {
    return this.display ?? { snapshot: (scope) => getAgentDisplay().snapshot(scope) };
  }

  private parseChannelTarget(target: string): string {
    if (!CHANNEL_TARGET.test(target))
      throw new AgentChannelManagementError(400, "target must be a #channel");
    return target.slice(1);
  }

  private normalizeChannelName(rawName: string): string {
    const name = rawName.startsWith("#") ? rawName.slice(1) : rawName;
    if (!CHANNEL_NAME.test(name))
      throw new AgentChannelManagementError(400, "invalid channel name");
    return name;
  }

  private parseMemberInput(input: AgentChannelMemberInput): {
    kind: "user" | "agent";
    handle: string;
  } {
    if ((input.user === undefined) === (input.agent === undefined))
      throw new AgentChannelManagementError(400, "exactly one of --user or --agent is required");
    const kind: "user" | "agent" = input.user !== undefined ? "user" : "agent";
    const raw = (input.user ?? input.agent)!;
    if (!MEMBER_HANDLE.test(raw))
      throw new AgentChannelManagementError(400, "member handle must be an @handle");
    return { kind, handle: raw.slice(1) };
  }
}
