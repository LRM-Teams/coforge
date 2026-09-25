import { VISIBLE_CONVERSATION_WHERE } from "./active-member.server";
import {
  actionCardActionSchema,
  validateActionCardAction,
  type ActionCardAction,
  type ActionCardKind,
  type ResolvedActionCardPayload,
} from "@lrm/coforge-sdk/agent";
import { isChannelMessageTarget } from "@lrm/coforge-sdk/internal";
import { AGENT_VISIBILITY } from "#src/features/agents/agent-visibility";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { ActionCardError } from "./action-card-error.server";
import { lockConversation } from "./conversation-lock.server";
import {
  getAgentChannel,
  PublicChannels,
  resolveChannelThreadRoot,
} from "./public-channels.server";
import { ConversationHistory } from "./conversation-history.server";
import { allocateSequence } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { messageSignalScope, type ConversationRealtime } from "./conversation-realtime.server";
import { isAdminLike } from "#src/server/workspaces/member-role.server";
import { workspaceMemberRole } from "#src/server/workspaces/members.server";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ActionCardPrepareResult = { messageId: string; metadata: { kind: "action-card" } };

export type ActionCardState = "pending" | "executed" | "cancelled";

/** A resolved id plus display name for a card's chips; unresolved ids render as "unknown". */
export type ActionCardRef = { id: string; displayName: string };

export type ActionCardViewBase = {
  messageId: string;
  state: ActionCardState;
  draftHint?: string;
  committedBy?: { displayName: string };
  committedAt?: string;
  /** Whether the viewer may commit this card right now (implies `state === "pending"`). */
  canCommit: boolean;
  /** Whether the viewer may cancel this card right now (implies `state === "pending"`). */
  canCancel: boolean;
};

export type ActionCardView =
  | (ActionCardViewBase & {
      kind: "channel:create";
      name: string;
      visibility: "public" | "private";
      description?: string;
      initialHumans: ActionCardRef[];
      initialAgents: ActionCardRef[];
      result?: { channelId: string };
    })
  | (ActionCardViewBase & {
      kind: "agent:create";
      name: string;
      description?: string;
      suggestedComputer?: ActionCardRef;
      requiredComputer?: ActionCardRef;
      result?: { agentId: string };
    })
  | (ActionCardViewBase & {
      kind: "channel:add_member";
      channel: ActionCardRef;
      humans: ActionCardRef[];
      agents: ActionCardRef[];
      result?: { channelId: string; userIds: string[]; agentIds: string[] };
    });

async function safeWorkspaceRole(db: PrismaClient, workspaceId: string, userId: string) {
  try {
    return await workspaceMemberRole(db, workspaceId, userId);
  } catch {
    return undefined;
  }
}

/**
 * The narrow slice of `DirectConversationRepository` `ActionCards` needs to resolve a `@user` DM
 * target, required (not optional) here since every call site always provides a real repository.
 */
export type ActionCardTargetRepository = {
  userIdForUsername(target: string): Promise<string>;
  getOrCreateUserAgent(
    workspaceId: string,
    userId: string,
    agentId: string,
  ): Promise<{ id: string }>;
};

/** Strips one leading `@` or `#`, if present. */
function bareHandle(value: string): string {
  return value.startsWith("@") || value.startsWith("#") ? value.slice(1) : value;
}

function ensureAt(value: string): string {
  return value.startsWith("@") ? value : `@${value}`;
}

function ensureHash(value: string): string {
  return value.startsWith("#") ? value : `#${value}`;
}

/** The one-line, human-readable summary that becomes the posted Message body. */
function summaryFor(action: ActionCardAction): string {
  if (action.type === "channel:create") return `Action card: create channel #${action.name}`;
  if (action.type === "agent:create") return `Action card: create agent ${action.name}`;
  const actors = [...(action.humans ?? []), ...(action.agents ?? [])].map(ensureAt);
  return `Action card: add ${actors.join(", ")} to ${ensureHash(bareHandle(action.channel))}`;
}

/**
 * Resolves an Agent-prepared action card (`coforge action prepare`) into a posted Message plus an
 * `ActionCard` record, mirroring Raft Computer 1.0.32's `prepare-action` route (see
 * `docs/agents/reference-cli-research.md` and `packages/coforge-sdk/src/agent/action-cards.ts`).
 * A human commits the card under their own identity in a follow-up PR; this PR only persists it
 * and renders it as an ordinary Agent message with a readable summary.
 */
export class ActionCards {
  constructor(
    private readonly db: PrismaClient,
    /** Only required by `prepare`; `viewsFor`/`commit*`/`cancel` do not need a target repository. */
    private readonly conversations?: ActionCardTargetRepository,
    private readonly realtime?: ConversationRealtime,
  ) {}

  async prepare(
    principal: { workspaceId: string; agentId: string },
    input: { target: string; action: unknown },
  ): Promise<ActionCardPrepareResult> {
    const parsed = actionCardActionSchema.safeParse(input.action);
    if (!parsed.success) {
      const issues = parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
      );
      throw new ActionCardError(422, "INVALID_ACTION", "Action failed validation", { issues });
    }
    const action = parsed.data;
    const crossFieldError = validateActionCardAction(action);
    if (crossFieldError) throw new ActionCardError(422, "INVALID_ACTION", crossFieldError);
    if (action.type === "channel:create" && action.visibility === "private")
      throw new ActionCardError(422, "INVALID_ACTION", "private channels are not supported yet");

    const target = await this.resolveTarget(principal.workspaceId, principal.agentId, input.target);
    const payload = await this.resolvePayload(principal.workspaceId, action);
    const body = action.draftHint
      ? `${summaryFor(action)}\n${action.draftHint}`
      : summaryFor(action);

    const created = await this.db.$transaction(async (tx) => {
      await lockConversation(tx, target.conversationId);
      const sequence = await allocateSequence(tx, target.conversationId);
      const message = await tx.message.create({
        data: {
          conversationId: target.conversationId,
          workspaceId: principal.workspaceId,
          senderMemberId: target.senderMemberId,
          threadRootId: target.threadRootId,
          body,
          sequence,
        },
        select: { id: true, sequence: true },
      });
      await tx.actionCard.create({
        data: {
          messageId: message.id,
          conversationId: target.conversationId,
          workspaceId: principal.workspaceId,
          kind: action.type,
          payload: payload as unknown as Prisma.InputJsonValue,
          draftHint: action.draftHint,
          preparedByAgentId: principal.agentId,
        },
      });
      return message;
    });

    // A card waits for a person to commit it, so it wakes no Agent; only the browser realtime publish.
    try {
      await this.realtime?.messageAvailable({
        conversationId: target.conversationId,
        messageId: created.id,
        sequence: created.sequence,
        ...(await messageSignalScope(this.db, target.conversationId, principal.workspaceId)),
        threadRootId: target.threadRootId,
      });
    } catch {
      // PostgreSQL remains canonical; browser reconciliation repairs a missed publication.
    }

    return { messageId: created.id, metadata: { kind: "action-card" } };
  }

  /**
   * Browser-facing views for a page of messages, one batched lookup per page (never per message):
   * every referenced user/Agent/channel/computer, plus the viewer's Workspace role and channel
   * memberships, in one `Promise.all`. Messages without a card are absent from the returned map.
   * Names that no longer resolve (a deleted user, Agent, channel, or computer) render as "unknown".
   */
  async viewsFor(
    workspaceId: string,
    viewerUserId: string,
    messageIds: string[],
  ): Promise<Map<string, ActionCardView>> {
    const ids = [...new Set(messageIds)];
    if (!ids.length) return new Map();
    const cards = await this.db.actionCard.findMany({
      where: { workspaceId, messageId: { in: ids } },
      select: {
        messageId: true,
        kind: true,
        payload: true,
        draftHint: true,
        state: true,
        committedByUserId: true,
        committedAt: true,
        result: true,
        preparedByAgent: { select: { ownerId: true } },
      },
    });
    if (!cards.length) return new Map();

    const userIds = new Set<string>();
    const agentIds = new Set<string>();
    const channelIds = new Set<string>();
    const computerIds = new Set<string>();
    for (const card of cards) {
      const payload = card.payload as ResolvedActionCardPayload;
      if (payload.type === "channel:create") {
        for (const id of payload.initialHumanIds ?? []) userIds.add(id);
        for (const id of payload.initialAgentIds ?? []) agentIds.add(id);
      } else if (payload.type === "agent:create") {
        if (payload.suggestedComputerId) computerIds.add(payload.suggestedComputerId);
        if (payload.requiredComputerId) computerIds.add(payload.requiredComputerId);
      } else {
        channelIds.add(payload.channelId);
        for (const id of payload.humanIds ?? []) userIds.add(id);
        for (const id of payload.agentIds ?? []) agentIds.add(id);
      }
      if (card.committedByUserId) userIds.add(card.committedByUserId);
    }

    const [users, agents, channels, computers, viewerRole, viewerChannelMemberships] =
      await Promise.all([
        userIds.size
          ? this.db.user.findMany({
              where: { id: { in: [...userIds] } },
              select: { id: true, username: true, displayName: true },
            })
          : Promise.resolve([]),
        agentIds.size
          ? this.db.agent.findMany({
              where: { id: { in: [...agentIds] } },
              select: { id: true, name: true, displayName: true },
            })
          : Promise.resolve([]),
        channelIds.size
          ? this.db.conversation.findMany({
              // A channel hidden from the Workspace is named on no card.
              where: { id: { in: [...channelIds] }, ...VISIBLE_CONVERSATION_WHERE },
              select: { id: true, channelName: true },
            })
          : Promise.resolve([]),
        computerIds.size
          ? this.db.computer.findMany({
              where: { id: { in: [...computerIds] } },
              select: { id: true, name: true, displayName: true },
            })
          : Promise.resolve([]),
        safeWorkspaceRole(this.db, workspaceId, viewerUserId),
        channelIds.size
          ? this.db.conversationMember.findMany({
              where: { conversationId: { in: [...channelIds] }, userId: viewerUserId },
              select: { conversationId: true },
            })
          : Promise.resolve([]),
      ]);

    const userName = new Map(users.map((u) => [u.id, u.displayName?.trim() || u.username]));
    const agentName = new Map(agents.map((a) => [a.id, a.displayName?.trim() || a.name]));
    const channelName = new Map(channels.map((c) => [c.id, c.channelName ?? "unknown"]));
    const computerName = new Map(
      computers.map((c) => [c.id, c.displayName?.trim() || c.name || "unknown"]),
    );
    const viewerChannelIds = new Set(viewerChannelMemberships.map((m) => m.conversationId));
    const isAdminViewer = viewerRole ? isAdminLike(viewerRole) : false;
    const ref = (id: string, names: Map<string, string>): ActionCardRef => ({
      id,
      displayName: names.get(id) ?? "unknown",
    });

    const views = new Map<string, ActionCardView>();
    for (const card of cards) {
      const payload = card.payload as ResolvedActionCardPayload;
      const state = card.state as ActionCardState;
      const pending = state === "pending";
      const base: ActionCardViewBase = {
        messageId: card.messageId,
        state,
        draftHint: card.draftHint ?? undefined,
        committedBy: card.committedByUserId
          ? { displayName: userName.get(card.committedByUserId) ?? "unknown" }
          : undefined,
        committedAt: card.committedAt?.toISOString(),
        canCommit: false,
        canCancel: pending && (card.preparedByAgent.ownerId === viewerUserId || isAdminViewer),
      };
      if (payload.type === "channel:create") {
        views.set(card.messageId, {
          ...base,
          kind: "channel:create",
          name: payload.name,
          visibility: payload.visibility,
          description: payload.description,
          initialHumans: (payload.initialHumanIds ?? []).map((id) => ref(id, userName)),
          initialAgents: (payload.initialAgentIds ?? []).map((id) => ref(id, agentName)),
          canCommit: pending,
          result: card.result as { channelId: string } | undefined,
        });
      } else if (payload.type === "agent:create") {
        views.set(card.messageId, {
          ...base,
          kind: "agent:create",
          name: payload.name,
          description: payload.description,
          suggestedComputer: payload.suggestedComputerId
            ? ref(payload.suggestedComputerId, computerName)
            : undefined,
          requiredComputer: payload.requiredComputerId
            ? ref(payload.requiredComputerId, computerName)
            : undefined,
          canCommit: pending && isAdminViewer,
          result: card.result as { agentId: string } | undefined,
        });
      } else {
        views.set(card.messageId, {
          ...base,
          kind: "channel:add_member",
          channel: ref(payload.channelId, channelName),
          humans: (payload.humanIds ?? []).map((id) => ref(id, userName)),
          agents: (payload.agentIds ?? []).map((id) => ref(id, agentName)),
          canCommit: pending && viewerChannelIds.has(payload.channelId),
          result: card.result as
            | { channelId: string; userIds: string[]; agentIds: string[] }
            | undefined,
        });
      }
    }
    return views;
  }

  /**
   * Shared commit/cancel guard: the card must exist in the caller's Workspace, the viewer must be
   * able to read the conversation it was posted in (reuses `ConversationHistory.authorize`), it
   * must be the expected kind, and it must still be `pending`. `commit*`/`cancel` re-check the
   * `pending` state atomically via a conditional `updateMany` *after* executing the underlying
   * operation — see `markExecuted`/`cancel`'s doc comments for why that ordering is safe against a
   * double click (the operation's own uniqueness rule, or `addMembers`'s `skipDuplicates`, absorbs
   * the race; this early check only produces a fast, friendly error for the common case).
   */
  private async loadPendingCard(
    workspaceId: string,
    actorUserId: string,
    messageId: string,
    kind: ActionCardKind,
  ) {
    const card = await this.db.actionCard.findUnique({
      where: { messageId },
      select: {
        messageId: true,
        conversationId: true,
        workspaceId: true,
        kind: true,
        payload: true,
        state: true,
        preparedByAgent: { select: { ownerId: true } },
      },
    });
    if (!card || card.workspaceId !== workspaceId) throw new AppError("NOT_FOUND");
    await new ConversationHistory(this.db).authorize(workspaceId, actorUserId, card.conversationId);
    if (card.kind !== kind) throw new AppError("INVALID_INPUT");
    if (card.state !== "pending") throw new AppError("CONFLICT");
    return card;
  }

  /**
   * Marks a card `executed` under the committing human's identity. Ordering: the caller always
   * executes the real operation (`PublicChannels.create`/`addMembers`, or `ManageAgents.create` in
   * `agents.functions.ts`) first, then calls this. The conditional `updateMany` is the final,
   * race-safe guard: a concurrent second commit fails on the operation's own uniqueness rule
   * (channel/Agent name) or is a harmless no-op (`addMembers`'s `skipDuplicates`), then finds
   * `count === 0` here and reports `CONFLICT` even though its own operation "succeeded".
   */
  private async markExecuted(
    messageId: string,
    conversationId: string,
    actorUserId: string,
    result: Record<string, unknown>,
  ) {
    const updated = await this.db.actionCard.updateMany({
      where: { messageId, state: "pending" },
      data: {
        state: "executed",
        committedByUserId: actorUserId,
        committedAt: new Date(),
        result: result as unknown as Prisma.InputJsonValue,
      },
    });
    if (updated.count === 0) throw new AppError("CONFLICT");
    await this.publishCardUpdate(conversationId, messageId);
  }

  private async publishCardUpdate(conversationId: string, messageId: string) {
    try {
      const message = await this.db.message.findUnique({
        where: { id: messageId },
        select: { sequence: true, threadRootId: true, workspaceId: true },
      });
      if (message)
        await this.realtime?.messageAvailable({
          conversationId,
          messageId,
          sequence: message.sequence,
          // A card prepared inside a thread stays a thread reply here: republishing it without
          // its anchor would let the browser count it as a channel message.
          ...(message.threadRootId ? { threadRootId: message.threadRootId } : {}),
          ...(await messageSignalScope(this.db, conversationId, message.workspaceId)),
        });
    } catch {
      // PostgreSQL remains canonical; browser reconciliation repairs a missed publication.
    }
  }

  /** `channel:create` commit: `PublicChannels.create` (any Workspace member), then
   * `PublicChannels.addMembers` for the human-selected initial humans/Agents (the creator is
   * already a member, so they may add). */
  async commitChannelCreate(
    principal: { workspaceId: string; actorUserId: string },
    input: {
      messageId: string;
      name: string;
      projectId?: string;
      memberUserIds: string[];
      memberAgentIds: string[];
    },
  ): Promise<{ channelId: string }> {
    const card = await this.loadPendingCard(
      principal.workspaceId,
      principal.actorUserId,
      input.messageId,
      "channel:create",
    );
    const channels = new PublicChannels(this.db, undefined, undefined, undefined, this.realtime);
    // The Agent-proposed description (`Conversation.description`) rides along from the
    // card's own resolved payload, not a new browser-supplied input: it is the Agent's context,
    // not something the committing human retypes.
    const payload = card.payload as ResolvedActionCardPayload & { type: "channel:create" };
    const created = await channels.create(
      principal.workspaceId,
      principal.actorUserId,
      input.name,
      input.projectId,
      payload.description,
    );
    if (input.memberUserIds.length || input.memberAgentIds.length) {
      await channels.addMembers(
        principal.workspaceId,
        { userId: principal.actorUserId },
        created.id,
        {
          userIds: input.memberUserIds,
          agentIds: input.memberAgentIds,
        },
      );
    }
    const result = { channelId: created.id };
    await this.markExecuted(input.messageId, card.conversationId, principal.actorUserId, result);
    return result;
  }

  /** `channel:add_member` commit: `PublicChannels.addMembers`, which already requires the actor
   * to be a member of the target channel (`ACCESS_DENIED` otherwise). */
  async commitChannelAddMember(
    principal: { workspaceId: string; actorUserId: string },
    input: { messageId: string; channelId: string; userIds: string[]; agentIds: string[] },
  ): Promise<{ channelId: string; userIds: string[]; agentIds: string[] }> {
    const card = await this.loadPendingCard(
      principal.workspaceId,
      principal.actorUserId,
      input.messageId,
      "channel:add_member",
    );
    const channels = new PublicChannels(this.db, undefined, undefined, undefined, this.realtime);
    await channels.addMembers(
      principal.workspaceId,
      { userId: principal.actorUserId },
      input.channelId,
      {
        userIds: input.userIds,
        agentIds: input.agentIds,
      },
    );
    const result = { channelId: input.channelId, userIds: input.userIds, agentIds: input.agentIds };
    await this.markExecuted(input.messageId, card.conversationId, principal.actorUserId, result);
    return result;
  }

  /**
   * `agent:create` commit runs through the existing `createAgent` seam in `agents.functions.ts`,
   * which submits the human's full runtime form and enforces `assertCanCreateAgents` itself (a
   * plain member is denied there and the card stays `pending`). This only performs the shared
   * pre-check; call `completeAgentCreate` after `ManageAgents.create` succeeds.
   */
  async assertAgentCreateCommittable(
    workspaceId: string,
    actorUserId: string,
    messageId: string,
    computerId: string,
  ): Promise<void> {
    await this.loadPendingCard(workspaceId, actorUserId, messageId, "agent:create");
    // `requiredComputer` is a placement contract, not a UI hint: never fall back to another Computer.
    const card = await this.db.actionCard.findUniqueOrThrow({
      where: { messageId },
      select: { payload: true },
    });
    const required = (card.payload as { requiredComputerId?: string }).requiredComputerId;
    if (required && required !== computerId) throw new AppError("INVALID_INPUT");
  }

  async completeAgentCreate(
    workspaceId: string,
    actorUserId: string,
    messageId: string,
    agentId: string,
  ): Promise<void> {
    const card = await this.db.actionCard.findUnique({
      where: { messageId },
      select: { conversationId: true, workspaceId: true },
    });
    if (!card || card.workspaceId !== workspaceId) throw new AppError("NOT_FOUND");
    await this.markExecuted(messageId, card.conversationId, actorUserId, { agentId });
  }

  /** Cancel: allowed for the preparing Agent's owner (`Agent.ownerId`) or a Workspace owner/admin. */
  async cancel(
    principal: { workspaceId: string; actorUserId: string },
    messageId: string,
  ): Promise<void> {
    const card = await this.db.actionCard.findUnique({
      where: { messageId },
      select: {
        conversationId: true,
        workspaceId: true,
        state: true,
        preparedByAgent: { select: { ownerId: true } },
      },
    });
    if (!card || card.workspaceId !== principal.workspaceId) throw new AppError("NOT_FOUND");
    await new ConversationHistory(this.db).authorize(
      principal.workspaceId,
      principal.actorUserId,
      card.conversationId,
    );
    if (card.state !== "pending") throw new AppError("CONFLICT");
    const role = await safeWorkspaceRole(this.db, principal.workspaceId, principal.actorUserId);
    const canCancel =
      card.preparedByAgent.ownerId === principal.actorUserId || (role ? isAdminLike(role) : false);
    if (!canCancel) throw new AppError("ACCESS_DENIED");
    const updated = await this.db.actionCard.updateMany({
      where: { messageId, state: "pending" },
      data: { state: "cancelled" },
    });
    if (updated.count === 0) throw new AppError("CONFLICT");
    await this.publishCardUpdate(card.conversationId, messageId);
  }

  /** Same target grammar and membership rules as Agent `message send` (see `direct-message.server.ts`). */
  private async resolveTarget(workspaceId: string, agentId: string, target: string) {
    const [parentTarget, anchor, extra] = target.split(":");
    if (!parentTarget || extra !== undefined) throw new AppError("INVALID_INPUT");
    // A channel thread's anchor is eight hex characters or the whole id, as for `message send`;
    // a shorter prefix that happens to be unique still names no thread.
    if (parentTarget.startsWith("#") && anchor !== undefined && !isChannelMessageTarget(target))
      throw new AppError("INVALID_INPUT");
    if (!this.conversations)
      throw new Error("ActionCards.prepare requires a conversations repository");
    const conversations = this.conversations;
    const conversationId = parentTarget.startsWith("#")
      ? (await getAgentChannel(this.db, workspaceId, agentId, parentTarget)).id
      : (
          await conversations.getOrCreateUserAgent(
            workspaceId,
            await conversations.userIdForUsername(target),
            agentId,
          )
        ).id;
    const threadRootId = anchor
      ? (await resolveChannelThreadRoot(this.db, conversationId, anchor)).id
      : undefined;
    const member = await this.db.conversationMember.findFirst({
      where: { conversationId, agentId },
      select: { id: true },
    });
    if (!member) throw new AppError("ACCESS_DENIED");
    return { conversationId, threadRootId, senderMemberId: member.id };
  }

  private async resolvePayload(
    workspaceId: string,
    action: ActionCardAction,
  ): Promise<ResolvedActionCardPayload> {
    if (action.type === "channel:create") {
      if (action.name === "general" || (await this.channelExists(workspaceId, action.name)))
        throw new ActionCardError(409, "CHANNEL_EXISTS", `channel #${action.name} already exists`);
      const [initialHumanIds, initialAgentIds] = await Promise.all([
        this.resolveHumans(workspaceId, action.initialHumans, "action.initialHumans"),
        this.resolveAgents(workspaceId, action.initialAgents, "action.initialAgents"),
      ]);
      return {
        type: "channel:create",
        name: action.name,
        visibility: action.visibility,
        description: action.description,
        ...(initialHumanIds ? { initialHumanIds } : {}),
        ...(initialAgentIds ? { initialAgentIds } : {}),
      };
    }
    if (action.type === "agent:create") {
      // A deleted Agent's name is free: creating the Agent renames the deleted holder.
      const existing = await this.db.agent.findFirst({
        where: { workspaceId, name: action.name, ...ACTIVE_AGENT_WHERE },
        select: { id: true },
      });
      if (existing)
        throw new ActionCardError(409, "AGENT_EXISTS", `agent ${action.name} already exists`);
      const [suggestedComputerId, requiredComputerId] = await Promise.all([
        action.suggestedComputer
          ? this.resolveComputer(workspaceId, action.suggestedComputer, "action.suggestedComputer")
          : Promise.resolve(undefined),
        action.requiredComputer
          ? this.resolveComputer(workspaceId, action.requiredComputer, "action.requiredComputer")
          : Promise.resolve(undefined),
      ]);
      return {
        type: "agent:create",
        name: action.name,
        description: action.description,
        ...(suggestedComputerId ? { suggestedComputerId } : {}),
        ...(requiredComputerId ? { requiredComputerId } : {}),
      };
    }
    const channelId = await this.resolveChannel(workspaceId, action.channel, "action.channel");
    const [humanIds, agentIds] = await Promise.all([
      this.resolveHumans(workspaceId, action.humans, "action.humans"),
      this.resolveAgents(workspaceId, action.agents, "action.agents"),
    ]);
    return {
      type: "channel:add_member",
      channelId,
      ...(humanIds ? { humanIds } : {}),
      ...(agentIds ? { agentIds } : {}),
    };
  }

  private async channelExists(workspaceId: string, name: string): Promise<boolean> {
    const channel = await this.db.conversation.findFirst({
      where: { workspaceId, channelName: name },
      select: { id: true },
    });
    return Boolean(channel);
  }

  private async resolveHumans(workspaceId: string, values: string[] | undefined, field: string) {
    if (!values?.length) return undefined;
    return Promise.all(
      values.map((value, index) => this.resolveHuman(workspaceId, value, `${field}[${index}]`)),
    );
  }

  private async resolveAgents(workspaceId: string, values: string[] | undefined, field: string) {
    if (!values?.length) return undefined;
    return Promise.all(
      values.map((value, index) => this.resolveAgent(workspaceId, value, `${field}[${index}]`)),
    );
  }

  private async resolveHuman(workspaceId: string, value: string, field: string): Promise<string> {
    const bare = bareHandle(value);
    const user = UUID_PATTERN.test(bare)
      ? await this.db.user.findFirst({
          where: { id: bare, memberships: { some: { workspaceId } } },
          select: { id: true },
        })
      : await this.db.user.findFirst({
          where: { username: bare, memberships: { some: { workspaceId } } },
          select: { id: true },
        });
    if (!user)
      throw new ActionCardError(422, "INVALID_HANDLE", `unknown human handle: ${value}`, { field });
    return user.id;
  }

  private async resolveAgent(workspaceId: string, value: string, field: string): Promise<string> {
    const bare = bareHandle(value);
    const agent = UUID_PATTERN.test(bare)
      ? await this.db.agent.findFirst({
          where: { id: bare, workspaceId, ...ACTIVE_AGENT_WHERE },
          select: { id: true, visibility: true },
        })
      : await this.db.agent.findFirst({
          where: { name: bare, workspaceId, ...ACTIVE_AGENT_WHERE },
          select: { id: true, visibility: true },
        });
    if (!agent)
      throw new ActionCardError(422, "INVALID_HANDLE", `unknown agent handle: ${value}`, { field });
    // Every Agent an action card names becomes a channel member, and a private Agent never is one.
    // Refusing here also keeps its display name out of a card rendered to the channel.
    if (agent.visibility !== AGENT_VISIBILITY.PUBLIC)
      throw new ActionCardError(
        422,
        "INVALID_HANDLE",
        `${value} is private and cannot be a channel member`,
        { field },
      );
    return agent.id;
  }

  private async resolveChannel(workspaceId: string, value: string, field: string): Promise<string> {
    const bare = bareHandle(value);
    const channel = UUID_PATTERN.test(bare)
      ? await this.db.conversation.findFirst({
          where: {
            id: bare,
            workspaceId,
            channelName: { not: null },
            ...VISIBLE_CONVERSATION_WHERE,
          },
          select: { id: true },
        })
      : await this.db.conversation.findFirst({
          where: { workspaceId, channelName: bare, ...VISIBLE_CONVERSATION_WHERE },
          select: { id: true },
        });
    if (!channel)
      throw new ActionCardError(422, "INVALID_HANDLE", `unknown channel handle: ${value}`, {
        field,
      });
    return channel.id;
  }

  private async resolveComputer(
    workspaceId: string,
    value: string,
    field: string,
  ): Promise<string> {
    const bare = bareHandle(value);
    const link = UUID_PATTERN.test(bare)
      ? await this.db.workspaceComputer.findFirst({
          where: { workspaceId, computerId: bare },
          select: { computerId: true },
        })
      : await this.db.workspaceComputer.findFirst({
          where: {
            workspaceId,
            computer: { OR: [{ name: bare }, { displayName: bare }] },
          },
          select: { computerId: true },
        });
    if (!link)
      throw new ActionCardError(422, "INVALID_HANDLE", `unknown computer handle: ${value}`, {
        field,
      });
    return link.computerId;
  }
}

export { ActionCardError } from "./action-card-error.server";

/**
 * Attaches `actionCard` to every message in a page that has one, in one batched
 * `ActionCards.viewsFor` lookup. Shared by the channel and direct-conversation message-page
 * Server Functions (`channels.functions.ts`, `conversations.functions.ts`) so the merge logic
 * lives in exactly one place instead of being repeated at each call site.
 */
export async function attachActionCardViews<T extends { id: string }>(
  db: PrismaClient,
  workspaceId: string,
  viewerUserId: string,
  messages: readonly T[],
): Promise<(T & { actionCard?: ActionCardView })[]> {
  if (!messages.length) return messages as (T & { actionCard?: ActionCardView })[];
  const views = await new ActionCards(db).viewsFor(
    workspaceId,
    viewerUserId,
    messages.map((message) => message.id),
  );
  if (!views.size) return messages as (T & { actionCard?: ActionCardView })[];
  return messages.map((message) =>
    views.has(message.id) ? { ...message, actionCard: views.get(message.id) } : message,
  );
}
