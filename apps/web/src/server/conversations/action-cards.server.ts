import {
  actionCardActionSchema,
  validateActionCardAction,
  type ActionCardAction,
  type ResolvedActionCardPayload,
} from "@lrm/coforge-sdk/agent";
import type { Prisma, PrismaClient } from "../../../generated/client";
import { AppError } from "../../lib/app-error";
import { ActionCardError } from "./action-card-error.server";
import { lockConversation } from "./conversation-lock.server";
import { getAgentChannel, resolveChannelThreadRoot } from "./public-channels.server";
import { allocateSequence } from "../db/repositories/direct-conversation.repositories.server";
import type { ConversationRealtime } from "./conversation-realtime.server";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ActionCardPrepareResult = { messageId: string; metadata: { kind: "action-card" } };

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
    private readonly conversations: ActionCardTargetRepository,
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

    // Agent-originated messages never wake other Agents; only the browser realtime publish.
    try {
      await this.realtime?.messageAvailable({
        conversationId: target.conversationId,
        messageId: created.id,
        sequence: created.sequence,
      });
    } catch {
      // PostgreSQL remains canonical; browser reconciliation repairs a missed publication.
    }

    return { messageId: created.id, metadata: { kind: "action-card" } };
  }

  /** Same target grammar and membership rules as Agent `message send` (see `direct-message.server.ts`). */
  private async resolveTarget(workspaceId: string, agentId: string, target: string) {
    const [parentTarget, anchor, extra] = target.split(":");
    if (!parentTarget || extra !== undefined) throw new AppError("INVALID_INPUT");
    const conversationId = parentTarget.startsWith("#")
      ? (await getAgentChannel(this.db, workspaceId, agentId, parentTarget)).id
      : (
          await this.conversations.getOrCreateUserAgent(
            workspaceId,
            await this.conversations.userIdForUsername(target),
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
      const existing = await this.db.agent.findFirst({
        where: { workspaceId, name: action.name },
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
      ? await this.db.agent.findFirst({ where: { id: bare, workspaceId }, select: { id: true } })
      : await this.db.agent.findFirst({ where: { name: bare, workspaceId }, select: { id: true } });
    if (!agent)
      throw new ActionCardError(422, "INVALID_HANDLE", `unknown agent handle: ${value}`, { field });
    return agent.id;
  }

  private async resolveChannel(workspaceId: string, value: string, field: string): Promise<string> {
    const bare = bareHandle(value);
    const channel = UUID_PATTERN.test(bare)
      ? await this.db.conversation.findFirst({
          where: { id: bare, workspaceId, channelName: { not: null } },
          select: { id: true },
        })
      : await this.db.conversation.findFirst({
          where: { workspaceId, channelName: bare },
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
