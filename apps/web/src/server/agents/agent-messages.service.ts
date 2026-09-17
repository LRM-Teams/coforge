import {
  isChannelMessageTarget,
  isChannelTarget,
  isValidReactionEmoji,
} from "@lrm/coforge-sdk/internal";
import {
  getAgentMessageHoldStore,
  hashAgentDraft,
  type AgentMessageHoldStore,
} from "../conversations/agent-message-hold.server";
import { AgentMessageValidationError } from "../conversations/agent-message-validation-error.server";

export type AgentMessageRepository = {
  readPendingAgentContext?(
    workspaceId: string,
    agentId: string,
    target: string,
    through?: number,
  ): Promise<readonly AgentMessageRecord[]>;
  /** Same pending-context scope as `readPendingAgentContext`, but a count rather than a 3-row window. */
  countPendingAgentContext?(
    workspaceId: string,
    agentId: string,
    target: string,
    through?: number,
  ): Promise<number>;
  advanceAgentReadThrough?(
    workspaceId: string,
    agentId: string,
    target: string,
    sequence: number,
  ): Promise<number>;
  setAgentChannelMuted(
    workspaceId: string,
    agentId: string,
    target: string,
    muted: boolean,
  ): Promise<unknown>;
  setAgentThreadFollowed(
    workspaceId: string,
    agentId: string,
    target: string,
    followed: boolean,
  ): Promise<unknown>;
  searchMessages?(
    workspaceId: string,
    agentId: string,
    options: Record<string, unknown>,
  ): Promise<readonly AgentMessageRecord[]>;
  readMessagesPage?(
    workspaceId: string,
    agentId: string,
    target: string,
    page: AgentMessagesPage,
  ): Promise<{ messages: readonly AgentMessageRecord[]; hasOlder: boolean; hasNewer: boolean }>;
  resolveAgentMessage?(
    workspaceId: string,
    agentId: string,
    messageId: string,
  ): Promise<AgentMessageRecord>;
  setAgentMessageReaction?(
    workspaceId: string,
    agentId: string,
    messageId: string,
    emoji: string,
    active: boolean,
  ): Promise<{ messageId: string }>;
  drainAgentEvents?(
    workspaceId: string,
    agentId: string,
    limit?: number,
  ): Promise<{ messages: readonly AgentMessageRecord[]; hasMore: boolean }>;
};

export type AgentMessagesPage = {
  before?: string;
  after?: string;
  around?: string;
  limit?: number;
  fromSequence?: number;
  throughSequence?: number;
};

export type AgentMentionSelector = { type: "user" | "agent"; id: string; name: string };

export type AgentSendMessageInput = {
  requestId: string;
  workspaceId: string;
  agentId: string;
  target: string;
  body: string;
  holdToken?: string;
  continueAnyway?: boolean;
  seenUpToSequence?: number;
  freshnessContextMode?: "inline" | "withheld";
  attachmentIds?: string[];
  mentions?: AgentMentionSelector[];
};

export type AgentSendMessageResult = {
  accepted: boolean;
  messageId?: string;
  attentionCount: number;
  sideEffectDecision: "forward" | "hold" | "anyway_denied" | "anyway_accepted";
  holdToken?: string;
  anywayAllowed?: boolean;
  freshnessContextMode?: "inline" | "withheld";
  withheldMessageCount?: number;
  /** Only when `sideEffectDecision === "anyway_accepted"` and `freshnessContextMode !== "withheld"`. */
  recentUnread?: readonly AgentMessageRecord[];
};

export async function executeAgentSendMessage(
  sender: {
    executeFromAgent(input: {
      requestId: string;
      workspaceId: string;
      agentId: string;
      target: string;
      body: string;
      attachmentIds?: string[];
      mentions?: AgentMentionSelector[];
    }): Promise<{ id: string }>;
  },
  input: AgentSendMessageInput,
): Promise<AgentSendMessageResult> {
  const message = await sender.executeFromAgent(input);
  return {
    accepted: true,
    messageId: message.id,
    attentionCount: 0,
    sideEffectDecision: input.continueAnyway ? "anyway_accepted" : "forward",
  };
}

export async function executeAgentSendMessageWithPolicy(
  dependencies: {
    repository: {
      readPendingAgentContext?(
        workspaceId: string,
        agentId: string,
        target: string,
        through?: number,
      ): Promise<readonly AgentMessageRecord[]>;
      countPendingAgentContext?(
        workspaceId: string,
        agentId: string,
        target: string,
        through?: number,
      ): Promise<number>;
      advanceAgentReadThrough?(
        workspaceId: string,
        agentId: string,
        target: string,
        sequence: number,
      ): Promise<number>;
    };
    sender: Parameters<typeof executeAgentSendMessage>[0];
    holdStore?: AgentMessageHoldStore;
  },
  input: AgentSendMessageInput,
): Promise<AgentSendMessageResult & { messages: readonly AgentMessageRecord[] }> {
  const mode = input.freshnessContextMode ?? "inline";
  let seen = 0;
  if (input.seenUpToSequence !== undefined) {
    if (!dependencies.repository.advanceAgentReadThrough)
      throw new Error("Agent read-through advancement is unavailable");
    seen = await dependencies.repository.advanceAgentReadThrough(
      input.workspaceId,
      input.agentId,
      input.target,
      input.seenUpToSequence,
    );
  }
  const bodyHash = await hashAgentDraft(input.body);
  const holds =
    dependencies.holdStore ??
    (dependencies.repository.readPendingAgentContext || input.holdToken || input.continueAnyway
      ? getAgentMessageHoldStore()
      : undefined);
  const prior = input.holdToken && holds ? await holds.get(input.holdToken) : undefined;
  const validPrior =
    prior &&
    prior.agentId === input.agentId &&
    prior.workspaceId === input.workspaceId &&
    prior.target === input.target &&
    prior.bodyHash === bodyHash
      ? prior
      : undefined;
  if (input.continueAnyway && (!validPrior || validPrior.stage < 2))
    return {
      accepted: false,
      attentionCount: 0,
      sideEffectDecision: "anyway_denied",
      messages: [],
      freshnessContextMode: mode,
    };
  // Withheld mode never presented context to the Agent, so a re-hold must not
  // narrow to "since last presented" — it has to keep covering everything
  // still pending above the Agent's seen boundary.
  const pendingBoundary =
    Math.max(mode === "withheld" ? 0 : (validPrior?.presentedThrough ?? 0), seen) || undefined;
  const pending = await dependencies.repository.readPendingAgentContext?.(
    input.workspaceId,
    input.agentId,
    input.target,
    pendingBoundary,
  );
  const heldMessages = pending?.slice(-3) ?? [];
  if (heldMessages.length && !input.continueAnyway) {
    if (!holds) throw new Error("Agent message hold storage is unavailable");
    const hold = {
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      target: input.target,
      bodyHash,
      presentedThrough: Math.max(...heldMessages.map((m) => m.sequence)),
      stage: (validPrior ? 2 : 1) as 1 | 2,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    };
    const token = await holds.issue(hold);
    if (validPrior && input.holdToken) await holds.consume(input.holdToken, validPrior);
    // The 3-row `readPendingAgentContext` window is for inline display only;
    // withheld mode reports the true pending count when the repository can
    // provide it, falling back to the bounded window's length otherwise.
    const withheldMessageCount =
      mode === "withheld"
        ? ((await dependencies.repository.countPendingAgentContext?.(
            input.workspaceId,
            input.agentId,
            input.target,
            pendingBoundary,
          )) ??
          pending?.length ??
          0)
        : undefined;
    return {
      accepted: false,
      attentionCount: heldMessages.length,
      sideEffectDecision: "hold",
      holdToken: token,
      anywayAllowed: hold.stage === 2,
      // Withheld mode never returns message bodies, senders, or metadata —
      // only the state and a count of everything still pending.
      messages: mode === "withheld" ? [] : heldMessages,
      ...(mode === "withheld"
        ? { freshnessContextMode: "withheld" as const, withheldMessageCount }
        : {}),
    };
  }
  if (
    input.continueAnyway &&
    input.holdToken &&
    validPrior &&
    holds &&
    !(await holds.consume(input.holdToken, validPrior))
  )
    return {
      accepted: false,
      attentionCount: 0,
      sideEffectDecision: "anyway_denied",
      messages: [],
      freshnessContextMode: mode,
    };
  const sent = await executeAgentSendMessage(dependencies.sender, input);
  return {
    ...sent,
    messages: [],
    freshnessContextMode: mode,
    // Every other sent result reports no recently-missed messages; only a bypassed hold does, and
    // withheld mode never returns bodies for anything, including these.
    recentUnread:
      sent.sideEffectDecision === "anyway_accepted" && mode !== "withheld"
        ? (pending?.slice(-3) ?? [])
        : [],
  };
}

export async function readAgentMessages(
  repository: AgentMessageRepository,
  scope: { workspaceId: string; agentId: string },
  target: string,
  page: AgentMessagesPage,
) {
  if (!repository.readMessagesPage) throw new Error("Agent message read is unavailable");
  const result = await repository.readMessagesPage(scope.workspaceId, scope.agentId, target, page);
  return {
    ...result,
    messages: result.messages.map((message) => ({
      ...message,
      createdAt: message.createdAt.toISOString(),
    })),
  };
}

export type AgentMessageRecord = {
  id: string;
  sequence: number;
  sender: string;
  target: string;
  body: string;
  createdAt: Date;
  /** Always present, possibly empty; order matches send/upload order. */
  attachments: { id: string; fileName: string; contentType: string; sizeBytes: number }[];
};

export async function drainAgentEvents(
  repository: AgentMessageRepository,
  scope: { workspaceId: string; agentId: string },
  limit?: number,
) {
  if (!repository.drainAgentEvents) throw new Error("Agent event drain is unavailable");
  const result = await repository.drainAgentEvents(scope.workspaceId, scope.agentId, limit);
  return {
    ...result,
    messages: result.messages.map((message) => ({
      ...message,
      createdAt: message.createdAt.toISOString(),
    })),
  };
}

export async function searchAgentMessages(
  repository: AgentMessageRepository,
  scope: { workspaceId: string; agentId: string },
  options: Record<string, unknown>,
) {
  if (!repository.searchMessages) throw new Error("Agent message search is unavailable");
  const messages = await repository.searchMessages(scope.workspaceId, scope.agentId, options);
  return messages.map((message) => ({ ...message, createdAt: message.createdAt.toISOString() }));
}

export async function muteAgentChannel(
  repository: AgentMessageRepository,
  scope: { workspaceId: string; agentId: string },
  target: string,
  muted: boolean,
) {
  if (!isChannelTarget(target)) throw new Error("mute requires a channel target");
  await repository.setAgentChannelMuted(scope.workspaceId, scope.agentId, target, muted);
}

export async function unfollowAgentThread(
  repository: AgentMessageRepository,
  scope: { workspaceId: string; agentId: string },
  target: string,
) {
  if (!isChannelMessageTarget(target) || isChannelTarget(target))
    throw new Error("unfollow requires a channel thread target");
  await repository.setAgentThreadFollowed(scope.workspaceId, scope.agentId, target, false);
}

export async function resolveAgentMessage(
  repository: AgentMessageRepository,
  scope: { workspaceId: string; agentId: string },
  messageId: string,
) {
  if (!repository.resolveAgentMessage) throw new Error("Agent message resolve is unavailable");
  const message = await repository.resolveAgentMessage(scope.workspaceId, scope.agentId, messageId);
  return { ...message, createdAt: message.createdAt.toISOString() };
}

export async function reactToAgentMessage(
  repository: AgentMessageRepository,
  scope: { workspaceId: string; agentId: string },
  messageId: string,
  emoji: string,
  active: boolean,
) {
  if (!repository.setAgentMessageReaction) throw new Error("Agent message reaction is unavailable");
  if (!isValidReactionEmoji(emoji))
    throw new AgentMessageValidationError(
      "reaction emoji must be one to sixteen characters without whitespace",
    );
  return repository.setAgentMessageReaction(
    scope.workspaceId,
    scope.agentId,
    messageId,
    emoji,
    active,
  );
}
