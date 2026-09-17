import type { Conversation, PrismaClient } from "../../../generated/client";
import { ACTIVE_MEMBER_WHERE } from "./active-member.server";
import {
  AgentChannelManagementError,
  channelAuthorityDeniedError,
} from "./agent-channel-management-error.server";
import { agentHasAdminAuthority } from "../agents/agent-channel-authority.server";
import { resolveAgentChannelStatus } from "../agents/agent-channel-status.server";
import { getAgentDisplay, type AgentDisplay } from "../agents/agent-display.server";
import { PrismaDirectConversationRepository } from "../db/repositories/direct-conversation.repositories.server";

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
};

export type AgentChannelRoster = {
  target: string;
  agents: Array<{
    name: string;
    displayName: string;
    description: string;
    role: string;
    self: boolean;
    status: "online" | "offline" | "unknown";
    activity?: string;
    activityDetail?: string;
  }>;
  humans: Array<{ username: string; role: string }>;
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
  constructor(
    private readonly db: PrismaClient,
    private readonly display?: Pick<AgentDisplay, "snapshot">,
  ) {}

  async info(workspaceId: string, agentId: string, target: string): Promise<AgentChannelInfo> {
    const channelName = this.parseChannelTarget(target);
    const channel = await this.findChannel(workspaceId, channelName);
    return this.channelInfo(channel, agentId);
  }

  async members(workspaceId: string, agentId: string, target: string): Promise<AgentChannelRoster> {
    const parentTarget = target.split(":")[0] ?? "";
    if (parentTarget.startsWith("#")) {
      const channelName = this.parseChannelTarget(parentTarget);
      const channel = await this.findChannel(workspaceId, channelName);
      return this.roster(workspaceId, channel.id, agentId, `#${channel.channelName}`);
    }
    if (!USER_TARGET.test(parentTarget))
      throw new AgentChannelManagementError(400, "target must be a #channel or @user");
    const username = parentTarget.slice(1);
    const user = await this.db.user.findUnique({ where: { username }, select: { id: true } });
    if (!user) throw new AgentChannelManagementError(404, "channel not found");
    const conversation = await new PrismaDirectConversationRepository(this.db).getOrCreateUserAgent(
      workspaceId,
      user.id,
      agentId,
    );
    return this.roster(workspaceId, conversation.id, agentId, parentTarget);
  }

  async join(workspaceId: string, agentId: string, target: string) {
    const channelName = this.parseChannelTarget(target);
    const channel = await this.findChannel(workspaceId, channelName);
    if (channel.archivedAt) throw new AgentChannelManagementError(409, "channel is archived");
    await this.db.conversationMember.upsert({
      where: { conversationId_agentId: { conversationId: channel.id, agentId } },
      create: { conversationId: channel.id, workspaceId, agentId },
      update: { leftAt: null },
    });
    return { target: `#${channel.channelName}`, joined: true };
  }

  async leave(workspaceId: string, agentId: string, target: string) {
    const channelName = this.parseChannelTarget(target);
    if (channelName === "general")
      throw new AgentChannelManagementError(400, "cannot leave #general");
    const channel = await this.findChannel(workspaceId, channelName);
    await this.db.conversationMember.updateMany({
      where: { conversationId: channel.id, agentId, ...ACTIVE_MEMBER_WHERE },
      data: { leftAt: new Date() },
    });
    return { target: `#${channel.channelName}`, joined: false };
  }

  async create(
    workspaceId: string,
    agentId: string,
    rawName: string,
    description: string | undefined,
  ) {
    if (!(await agentHasAdminAuthority(this.db, workspaceId, agentId)))
      throw channelAuthorityDeniedError("create");
    const name = this.normalizeChannelName(rawName);
    if (name === "general")
      throw new AgentChannelManagementError(409, "general is reserved for automatic enrollment");
    try {
      const channel = await this.db.conversation.create({
        data: {
          workspaceId,
          channelName: name,
          description: description ?? "",
          members: { create: { agentId } },
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
    if (!(await agentHasAdminAuthority(this.db, workspaceId, agentId)))
      throw channelAuthorityDeniedError("update");
    if (patch.name === undefined && patch.description === undefined)
      throw new AgentChannelManagementError(400, "update requires --name or --description");
    const channelName = this.parseChannelTarget(target);
    const channel = await this.findChannel(workspaceId, channelName);
    let nextName = channel.channelName!;
    if (patch.name !== undefined) {
      if (channelName === "general")
        throw new AgentChannelManagementError(400, "cannot rename #general");
      nextName = this.normalizeChannelName(patch.name);
      if (nextName === "general")
        throw new AgentChannelManagementError(409, "general is reserved for automatic enrollment");
    }
    try {
      const updated = await this.db.conversation.update({
        where: { id: channel.id },
        data: {
          ...(patch.name !== undefined ? { channelName: nextName } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
        },
      });
      return this.channelInfo(updated, agentId);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "P2002")
        throw new AgentChannelManagementError(409, "channel name is already in use");
      throw error;
    }
  }

  async setArchived(workspaceId: string, agentId: string, target: string, archived: boolean) {
    const operation = archived ? "archive" : "unarchive";
    if (!(await agentHasAdminAuthority(this.db, workspaceId, agentId)))
      throw channelAuthorityDeniedError(operation);
    const channelName = this.parseChannelTarget(target);
    if (channelName === "general")
      throw new AgentChannelManagementError(400, `cannot ${operation} #general`);
    const channel = await this.findChannel(workspaceId, channelName);
    await this.db.conversation.update({
      where: { id: channel.id },
      data: { archivedAt: archived ? new Date() : null },
    });
    return { target: `#${channel.channelName}`, archived };
  }

  async addMember(
    workspaceId: string,
    callingAgentId: string,
    target: string,
    input: AgentChannelMemberInput,
  ) {
    const channelName = this.parseChannelTarget(target);
    const { kind, handle } = this.parseMemberInput(input);
    const channel = await this.findChannel(workspaceId, channelName);
    if (!(await agentHasAdminAuthority(this.db, workspaceId, callingAgentId)))
      throw channelAuthorityDeniedError("add-member");
    if (kind === "user") {
      const user = await this.db.user.findUnique({ where: { username: handle } });
      const membership = user
        ? await this.db.workspaceMembership.findUnique({
            where: { workspaceId_userId: { workspaceId, userId: user.id } },
          })
        : null;
      if (!user || !membership)
        throw new AgentChannelManagementError(404, `member not found: @${handle}`);
      await this.db.conversationMember.upsert({
        where: { conversationId_userId: { conversationId: channel.id, userId: user.id } },
        create: { conversationId: channel.id, workspaceId, userId: user.id },
        update: { leftAt: null },
      });
    } else {
      const agentRow = await this.db.agent.findFirst({
        where: { workspaceId, name: handle },
        select: { id: true },
      });
      if (!agentRow) throw new AgentChannelManagementError(404, `member not found: @${handle}`);
      await this.db.conversationMember.upsert({
        where: { conversationId_agentId: { conversationId: channel.id, agentId: agentRow.id } },
        create: { conversationId: channel.id, workspaceId, agentId: agentRow.id },
        update: { leftAt: null },
      });
    }
    return {
      target: `#${channel.channelName}`,
      member: { kind, handle: `@${handle}` },
      added: true as const,
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
    if (channelName === "general")
      throw new AgentChannelManagementError(400, "cannot remove a member from #general");
    const channel = await this.findChannel(workspaceId, channelName);
    if (kind === "agent") {
      const agentRow = await this.db.agent.findFirst({
        where: { workspaceId, name: handle },
        select: { id: true },
      });
      if (!agentRow) throw new AgentChannelManagementError(404, `member not found: @${handle}`);
      const isSelf = agentRow.id === callingAgentId;
      if (!isSelf && !(await agentHasAdminAuthority(this.db, workspaceId, callingAgentId)))
        throw channelAuthorityDeniedError("remove-member");
      await this.db.conversationMember.updateMany({
        where: { conversationId: channel.id, agentId: agentRow.id, ...ACTIVE_MEMBER_WHERE },
        data: { leftAt: new Date() },
      });
    } else {
      if (!(await agentHasAdminAuthority(this.db, workspaceId, callingAgentId)))
        throw channelAuthorityDeniedError("remove-member");
      const user = await this.db.user.findUnique({ where: { username: handle } });
      if (!user) throw new AgentChannelManagementError(404, `member not found: @${handle}`);
      await this.db.conversationMember.updateMany({
        where: { conversationId: channel.id, userId: user.id, ...ACTIVE_MEMBER_WHERE },
        data: { leftAt: new Date() },
      });
    }
    return { target: `#${channel.channelName}`, removed: true as const };
  }

  private async findChannel(workspaceId: string, channelName: string): Promise<Conversation> {
    const channel = await this.db.conversation.findUnique({
      where: { workspaceId_channelName: { workspaceId, channelName } },
    });
    if (!channel) throw new AgentChannelManagementError(404, "channel not found");
    return channel;
  }

  private async channelInfo(
    channel: Pick<Conversation, "id" | "channelName" | "description" | "archivedAt">,
    agentId: string,
  ): Promise<AgentChannelInfo> {
    const [member, memberCounts] = await Promise.all([
      this.db.conversationMember.findFirst({
        where: { conversationId: channel.id, agentId, ...ACTIVE_MEMBER_WHERE },
        select: { channelMuted: true },
      }),
      this.memberCounts(channel.id),
    ]);
    return {
      id: channel.id,
      name: `#${channel.channelName}`,
      description: channel.description,
      archived: channel.archivedAt !== null,
      joined: Boolean(member),
      muted: member?.channelMuted ?? false,
      memberCounts,
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
    const agentRows = rows.filter(
      (row): row is typeof row & { agentId: string; agent: NonNullable<typeof row.agent> } =>
        Boolean(row.agentId && row.agent),
    );
    const humanRows = rows.filter(
      (row): row is typeof row & { userId: string; user: NonNullable<typeof row.user> } =>
        Boolean(row.userId && row.user),
    );
    const roles = humanRows.length
      ? await this.db.workspaceMembership.findMany({
          where: { workspaceId, userId: { in: humanRows.map((row) => row.userId) } },
          select: { userId: true, role: true },
        })
      : [];
    const roleByUserId = new Map(roles.map((role) => [role.userId, role.role]));
    // Deferred: constructing the real AgentDisplay throws when REDIS_URL is unset, and that
    // failure must be caught per-Agent (as "unknown") by resolveAgentChannelStatus, not thrown
    // out of the whole roster read.
    const display: Pick<AgentDisplay, "snapshot"> = this.display ?? {
      snapshot: (scope) => getAgentDisplay().snapshot(scope),
    };
    const agents = await Promise.all(
      agentRows.map(async (row) => ({
        name: row.agent.name,
        displayName: row.agent.displayName,
        description: row.agent.description,
        role: row.agent.role,
        self: row.agentId === callingAgentId,
        ...(await resolveAgentChannelStatus(display, {
          workspaceId,
          computerId: row.agent.computerId,
          agentId: row.agentId,
        })),
      })),
    );
    return {
      target,
      agents: agents.sort((left, right) => left.name.localeCompare(right.name)),
      humans: humanRows
        .map((row) => ({
          username: row.user.username,
          role: roleByUserId.get(row.userId) ?? "member",
        }))
        .sort((left, right) => left.username.localeCompare(right.username)),
    };
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
