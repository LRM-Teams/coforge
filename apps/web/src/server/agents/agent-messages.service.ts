import {
  freshnessDecisionFactId,
  isChannelMessageTarget,
  isChannelTarget,
  isValidReactionEmoji,
  type MessageSenderKind,
} from "@lrm/coforge-sdk/internal";
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
  /** The target's most recent messages, ignoring the Agent's own read boundary: the source of
   * Raft's first-touch `syncing_hold` (`target_first_touch_recent_context`). Own messages are not
   * context to review, so they are excluded. */
  readRecentAgentContext?(
    workspaceId: string,
    agentId: string,
    target: string,
    limit: number,
  ): Promise<readonly AgentMessageRecord[]>;
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
    target?: string,
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
  idempotencyKey: string;
  workspaceId: string;
  agentId: string;
  target: string;
  content: string;
  continueAnyway?: boolean;
  /** How many times this draft has already been held (Raft's local draft `reholdCount`). */
  draftReholdCount?: number;
  /** A normal send that replaced a draft the Agent had already been held on. */
  draftReplacedExisting?: boolean;
  seenUpToSeq?: number;
  freshnessContextMode?: "inline" | "withheld";
  attachmentIds?: string[];
  mentions?: AgentMentionSelector[];
};

export type AgentSendMessageResult = {
  state: "sent" | "held";
  /** Raft's side-effect decision: `forward`/`bypass` sent the message, `local_hold`/`syncing_hold`
   * held it as a draft. There is deliberately no "denied" outcome. */
  decision: "forward" | "bypass" | "local_hold" | "syncing_hold";
  reason?: string;
  messageId?: string;
  producerFactId?: string;
  /** Raft's `available_actions` on a held send (`apmHeldFreshnessAvailableActions("send")`). */
  availableActions?: readonly string[];
  /** Raft's `continueAnywaySuggested`: an already-re-held draft may be forced with `--anyway`. */
  continueAnywaySuggested?: boolean;
  heldMessages?: readonly AgentMessageRecord[];
  newMessageCount?: number;
  shownMessageCount?: number;
  omittedMessageCount?: number;
  seenUpToSeq?: number;
  freshnessContextMode?: "inline" | "withheld";
  withheldMessageCount?: number;
  /** Only when a sent message bypassed a hold and `freshnessContextMode !== "withheld"`. */
  recentUnread?: readonly AgentMessageRecord[];
};

/** Raft 1.0.32 `apmHeldFreshnessAvailableActions("send")`. */
const HELD_SEND_AVAILABLE_ACTIONS = ["check_messages", "send_draft", "send_anyway"] as const;

/** Raft 1.0.32 `DEFAULT_HELD_CONTEXT_LIMIT`. */
const HELD_CONTEXT_LIMIT = 3;

/** Raft 1.0.32's `stableNormalizeApmHeldFreshness` and
 * `buildApmFreshnessDecisionProducerFactId` now live in the SDK
 * (`@lrm/coforge-sdk/internal`), because a daemon that decides a hold locally never reaches the
 * server's code path and still has to produce the same `freshness_decision_fact:` id. */

export async function executeAgentSendMessage(
  sender: {
    // The domain layer (the shared `SendDirectMessage`) calls this key `requestId`; the Agent API
    // calls it `idempotencyKey`, so the two names meet here and nowhere else.
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
): Promise<{ messageId: string }> {
  const message = await sender.executeFromAgent({
    requestId: input.idempotencyKey,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    target: input.target,
    body: input.content,
    attachmentIds: input.attachmentIds,
    mentions: input.mentions,
  });
  return { messageId: message.id };
}

export async function executeAgentSendMessageWithPolicy(
  dependencies: {
    repository: {
      readPendingAgentContext?(
        workspaceId: string,
        agentId: string,
        target: string,
        afterSequence?: number,
      ): Promise<readonly AgentMessageRecord[]>;
      countPendingAgentContext?(
        workspaceId: string,
        agentId: string,
        target: string,
        afterSequence?: number,
      ): Promise<number>;
      readRecentAgentContext?(
        workspaceId: string,
        agentId: string,
        target: string,
        limit: number,
      ): Promise<readonly AgentMessageRecord[]>;
      advanceAgentReadThrough?(
        workspaceId: string,
        agentId: string,
        target: string,
        sequence: number,
      ): Promise<number>;
    };
    sender: Parameters<typeof executeAgentSendMessage>[0];
  },
  input: AgentSendMessageInput,
): Promise<AgentSendMessageResult> {
  const mode = input.freshnessContextMode ?? "inline";
  const withheld = mode === "withheld";
  // Raft: the Agent reports the boundary it has already reviewed; the server advances its own
  // read-through to it (monotone) and uses the advanced value as the freshness boundary.
  let seen = 0;
  if (input.seenUpToSeq !== undefined) {
    if (!dependencies.repository.advanceAgentReadThrough)
      throw new Error("Agent read-through advancement is unavailable");
    seen = await dependencies.repository.advanceAgentReadThrough(
      input.workspaceId,
      input.agentId,
      input.target,
      input.seenUpToSeq,
    );
  }
  // Withheld mode never presented context to the Agent, so a hold must cover everything still
  // pending above the boundary, not only "since the last presentation".
  const pendingBoundary = withheld ? undefined : seen || undefined;
  const pending = await dependencies.repository.readPendingAgentContext?.(
    input.workspaceId,
    input.agentId,
    input.target,
    pendingBoundary,
  );
  const unconsumed = pending ?? [];
  // Raft (`planAgentInboxSideEffect`): `continueAnyway` is the Agent's explicit decision to send
  // anyway (`--send-draft --anyway`). It short-circuits every hold and is never refused — there is
  // no "denied" outcome in Raft's contract.
  if (input.continueAnyway) {
    const sent = await executeAgentSendMessage(dependencies.sender, input);
    return {
      state: "sent",
      decision: "bypass",
      reason: "continue_anyway",
      messageId: sent.messageId,
      producerFactId: await freshnessDecisionFactId({
        agentId: input.agentId,
        decision: "bypass",
        reason: "continue_anyway",
        target: input.target,
        freshnessContextMode: mode,
        modelSeenSeq: seen || undefined,
      }),
      // A bypassed hold is the one sent result that reports what the Agent chose not to review.
      recentUnread: withheld ? [] : unconsumed.slice(-HELD_CONTEXT_LIMIT),
    };
  }
  // Unconsumed context for this exact target above the Agent's boundary -> `local_hold`.
  if (unconsumed.length > 0) {
    const heldMessages = withheld ? [] : unconsumed.slice(-HELD_CONTEXT_LIMIT);
    // The inline window is bounded for display, so the true newer count comes from the repository's
    // unbounded count in *both* modes; without that seam the window's length is all we know and
    // `omittedMessageCount` stays 0.
    const newMessageCount =
      (await dependencies.repository.countPendingAgentContext?.(
        input.workspaceId,
        input.agentId,
        input.target,
        pendingBoundary,
      )) ?? unconsumed.length;
    const seenUpToSeq = Math.max(seen, ...unconsumed.map((message) => message.sequence));
    return {
      state: "held",
      decision: "local_hold",
      reason: "exact_target_pending",
      producerFactId: await freshnessDecisionFactId({
        agentId: input.agentId,
        decision: "local_hold",
        reason: "exact_target_pending",
        target: input.target,
        freshnessContextMode: mode,
        pendingMaxSeq: seenUpToSeq,
        modelSeenSeq: seen || undefined,
        heldMessageCount: heldMessages.length,
        omittedMessageCount: Math.max(0, newMessageCount - heldMessages.length),
      }),
      availableActions: HELD_SEND_AVAILABLE_ACTIONS,
      continueAnywaySuggested: (input.draftReholdCount ?? 0) >= 1,
      // Withheld mode never returns message bodies, senders, or metadata — only the state and a
      // count of everything still pending.
      heldMessages,
      newMessageCount,
      shownMessageCount: heldMessages.length,
      omittedMessageCount: Math.max(0, newMessageCount - heldMessages.length),
      seenUpToSeq,
      ...(withheld
        ? { freshnessContextMode: "withheld" as const, withheldMessageCount: newMessageCount }
        : {}),
    };
  }
  // Raft's second hold kind, `syncing_hold` (`target_first_touch_recent_context`): the Agent has no
  // boundary for this target at all, and the target already carries context it has never reviewed,
  // so the send is held until the Agent syncs that context.
  if (seen === 0 && dependencies.repository.readRecentAgentContext) {
    const recent = await dependencies.repository.readRecentAgentContext(
      input.workspaceId,
      input.agentId,
      input.target,
      HELD_CONTEXT_LIMIT,
    );
    if (recent.length > 0) {
      const seenUpToSeq = Math.max(...recent.map((message) => message.sequence));
      return {
        state: "held",
        decision: "syncing_hold",
        reason: "target_first_touch_recent_context",
        producerFactId: await freshnessDecisionFactId({
          agentId: input.agentId,
          decision: "syncing_hold",
          reason: "target_first_touch_recent_context",
          target: input.target,
          freshnessContextMode: mode,
          pendingMaxSeq: seenUpToSeq,
          heldMessageCount: withheld ? 0 : recent.length,
          omittedMessageCount: 0,
        }),
        availableActions: HELD_SEND_AVAILABLE_ACTIONS,
        continueAnywaySuggested: (input.draftReholdCount ?? 0) >= 1,
        heldMessages: withheld ? [] : recent,
        newMessageCount: recent.length,
        shownMessageCount: withheld ? 0 : recent.length,
        omittedMessageCount: 0,
        seenUpToSeq,
        ...(withheld
          ? { freshnessContextMode: "withheld" as const, withheldMessageCount: recent.length }
          : {}),
      };
    }
  }
  const sent = await executeAgentSendMessage(dependencies.sender, input);
  const forwardReason =
    seen > 0 ? "model_seen_boundary" : "no_exact_target_pending_or_recent_context";
  return {
    state: "sent",
    decision: "forward",
    reason: forwardReason,
    messageId: sent.messageId,
    producerFactId: await freshnessDecisionFactId({
      agentId: input.agentId,
      decision: "forward",
      reason: forwardReason,
      target: input.target,
      freshnessContextMode: mode,
      modelSeenSeq: seen || undefined,
    }),
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
  senderKind: MessageSenderKind;
  /** Public handle without a leading "@"; required for "human"/"agent", empty for "system". */
  senderHandle: string;
  /** The sender's role text; empty when there is none. */
  senderDescription: string;
  target: string;
  body: string;
  createdAt: Date;
  /** Always present, possibly empty; order matches send/upload order. */
  attachments: { id: string; fileName: string; contentType: string; sizeBytes: number }[];
  mentionsAgent?: boolean;
};

export async function drainAgentEvents(
  repository: AgentMessageRepository,
  scope: { workspaceId: string; agentId: string },
  limit?: number,
  target?: string,
) {
  if (!repository.drainAgentEvents) throw new Error("Agent event drain is unavailable");
  const result = target
    ? await repository.drainAgentEvents(scope.workspaceId, scope.agentId, limit, target)
    : await repository.drainAgentEvents(scope.workspaceId, scope.agentId, limit);
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
