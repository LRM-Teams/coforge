import {
  HELD_CONTEXT_LIMIT,
  freshnessDecisionFactId,
  type FreshnessDecisionFactInput,
  isChannelMessageTarget,
  isChannelTarget,
  isValidReactionEmoji,
  type MessageSenderKind,
} from "@lrm/coforge-sdk/internal";
import type { AgentHistoryConsumptionScope } from "@lrm/coforge-sdk/agent";
import { AgentMessageValidationError } from "#src/server/conversations/agent-message-validation-error.server";
import type { PendingMentionActionView } from "#src/server/conversations/pending-mention-actions.server";
import {
  MessageRequestInProgressError,
  type MessageRequestRecords,
} from "#src/server/conversations/message-request-idempotency.server";

export type AgentMessageRepository = {
  /** One Agent-facing target resolved once, so a send's freshness reads and read-through advance
   * share that resolution instead of each resolving the target string again. */
  agentTargetFreshness?(
    workspaceId: string,
    agentId: string,
    target: string,
  ): Promise<AgentTargetFreshness>;
  /** What a message this Agent already committed did not reach, read from the message by its id:
   * the report a replay of its send answers with, the same one the original send gave. */
  committedAgentMentionReport?(
    workspaceId: string,
    agentId: string,
    messageId: string,
  ): Promise<{
    pendingMentionActions: PendingMentionActionView[];
    unresolvedMentionHandles: string[];
  }>;
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
  ): Promise<{
    messages: readonly AgentMessageRecord[];
    hasOlder: boolean;
    hasNewer: boolean;
    /** Raft 1.0.38's `model_seen_up_to_seq`: see `agentHistoryModelSeenBoundary`. */
    modelSeenUpToSeq: number | null;
    consumptionScope?: AgentHistoryConsumptionScope;
  }>;
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

/**
 * The freshness reads and read-through advance of one already-resolved Agent-facing target. The
 * Agent's own messages are never context to review (Raft's `isMessageModelSeen`), and every read
 * that takes `excludingSequences` (Raft 1.0.38's `seenExactSeqs`, the messages the Agent was shown
 * one by one) leaves those out as well: this port is the one place that rule is applied.
 */
export type AgentTargetFreshness = {
  /** The newest (at most three) pending messages above `afterSequence`, oldest first. */
  readPending?(
    afterSequence?: number,
    excludingSequences?: readonly number[],
  ): Promise<readonly AgentMessageRecord[]>;
  /** Same pending-context scope as `readPending`, but a count rather than a 3-row window. */
  countPending?(afterSequence?: number, excludingSequences?: readonly number[]): Promise<number>;
  /** The newest pending message's sequence above `afterSequence`, as one aggregate; `undefined`
   * when nothing is pending. */
  maxPendingSequence?(afterSequence?: number): Promise<number | undefined>;
  /** The target's `limit` most recent messages, ignoring the Agent's own read boundary: the source
   * of Raft's first-touch `syncing_hold` (`target_first_touch_recent_context`). `unseen` is that
   * window less `excludingSequences`, oldest first; `maxSequence` the window's newest. */
  readRecent?(
    limit: number,
    excludingSequences?: readonly number[],
  ): Promise<{ unseen: readonly AgentMessageRecord[]; maxSequence: number | undefined }>;
  /** The server's own read-through for the target: what reads, checks and reported boundaries
   * have consumed, as this send found it. */
  readThrough?(): Promise<number>;
  advanceReadThrough?(sequence: number): Promise<number>;
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
  /** Raft 1.0.38's `seenExactSeqs`: messages above `seenUpToSeq` the Agent was shown one by one. */
  seenExactSeqs?: readonly number[];
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
  /** Held: the boundary the Agent should treat as reviewed after this hold. Sent: the boundary this
   * send advanced over messages the Agent had already seen (Raft's consume effect), if any. */
  seenUpToSeq?: number;
  freshnessContextMode?: "inline" | "withheld";
  withheldMessageCount?: number;
  /** Only when a sent message bypassed a hold and `freshnessContextMode !== "withheld"`. */
  recentUnread?: readonly AgentMessageRecord[];
  /** Sent only: mentions of people outside the channel that notified no one, for the Agent to
   * act on (`coforge mention`). */
  pendingMentionActions?: readonly PendingMentionActionView[];
  /** Sent only: `@handle`s that name nobody the Agent can see. */
  unresolvedMentionHandles?: readonly string[];
};

/** Raft 1.0.32 `apmHeldFreshnessAvailableActions("send")`. */
const HELD_SEND_AVAILABLE_ACTIONS = ["check_messages", "send_draft", "send_anyway"] as const;

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
    }): Promise<{
      id: string;
      pendingMentionActions?: readonly PendingMentionActionView[];
      unresolvedMentionHandles?: readonly string[];
    }>;
  },
  input: AgentSendMessageInput,
): Promise<{
  messageId: string;
  pendingMentionActions: readonly PendingMentionActionView[];
  unresolvedMentionHandles: readonly string[];
}> {
  const message = await sender.executeFromAgent({
    requestId: input.idempotencyKey,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    target: input.target,
    body: input.content,
    attachmentIds: input.attachmentIds,
    mentions: input.mentions,
  });
  return {
    messageId: message.id,
    pendingMentionActions: message.pendingMentionActions ?? [],
    unresolvedMentionHandles: message.unresolvedMentionHandles ?? [],
  };
}

/** The answer to an Agent's `reconcileOnly` send (Raft 1.0.38). */
export type AgentSendReconciliation =
  | { state: "committed"; messageId: string }
  | { state: "not_found" };

/**
 * Whether an Agent's send under this idempotency key already committed, answered from the same
 * request record `executeFromAgent` writes — without the freshness check, a hold, or a send. A key
 * still being processed is the in-flight duplicate `MessageRequestInProgressError` reports:
 * Raft's contract has no state for it, and the daemon treats it as "cannot confirm".
 */
export async function reconcileAgentSendMessage(
  records: MessageRequestRecords,
  input: { idempotencyKey: string; workspaceId: string; agentId: string },
): Promise<AgentSendReconciliation> {
  const record = await records.find({
    workspaceId: input.workspaceId,
    senderKind: "agent",
    senderId: input.agentId,
    requestId: input.idempotencyKey,
  });
  if (!record) return { state: "not_found" };
  if (record.state === "processing") throw new MessageRequestInProgressError();
  return { state: "committed", messageId: record.message.id };
}

/** A send the plan lets through: Raft's `forwardPlan`, stated once for every forward reason. */
type ForwardPlan = {
  decision: "forward" | "bypass";
  reason: string;
  fact: Omit<FreshnessDecisionFactInput, "agentId" | "target" | "decision" | "reason">;
  /** Raft's consume effect: the read-through advances over messages the Agent has seen. */
  advanceTo?: number;
  /** A bypassed hold's report of what the Agent chose not to review. */
  recentUnread?: readonly AgentMessageRecord[];
};

/**
 * Raft 1.0.38's `planAgentInboxSideEffect` (bundle 898608-898776) and
 * `planFirstTouchRecentContext` (898796-898900), decided on the server, where the target's pending
 * and recent context live. A message counts as seen (`isMessageModelSeen`, 898964) when the Agent
 * sent it, when it is at or below the boundary the Agent reported, or when the Agent reports it
 * among `seenExactSeqs`, whatever the freshness mode. Raft's consume effects are the read-through
 * advance here and the `seenUpToSeq` a sent result carries back to the daemon.
 */
export async function executeAgentSendMessageWithPolicy(
  dependencies: {
    repository: Pick<
      AgentMessageRepository,
      "agentTargetFreshness" | "committedAgentMentionReport"
    >;
    sender: Parameters<typeof executeAgentSendMessage>[0];
    /** The send's request records: a key that already committed is answered from its record. */
    requestRecords?: MessageRequestRecords;
  },
  input: AgentSendMessageInput,
): Promise<AgentSendMessageResult> {
  // A replay of a key that already committed is answered from its record before the target is
  // resolved or its freshness read: whatever changed since (the person left, newer messages
  // arrived) must not report a committed send as refused or held. Like a `reconcileOnly`
  // `committed`, it publishes nothing again; what the message did not reach is read from the
  // message, so the replay reports what the original did. A key still being processed is the
  // in-flight duplicate.
  if (dependencies.requestRecords) {
    const reconciliation = await reconcileAgentSendMessage(dependencies.requestRecords, input);
    if (reconciliation.state === "committed") {
      const report = await dependencies.repository.committedAgentMentionReport?.(
        input.workspaceId,
        input.agentId,
        reconciliation.messageId,
      );
      return {
        state: "sent",
        decision: "forward",
        reason: "already_committed",
        messageId: reconciliation.messageId,
        pendingMentionActions: report?.pendingMentionActions ?? [],
        unresolvedMentionHandles: report?.unresolvedMentionHandles ?? [],
      };
    }
  }
  const mode = input.freshnessContextMode ?? "inline";
  const freshness = await dependencies.repository.agentTargetFreshness?.(
    input.workspaceId,
    input.agentId,
    input.target,
  );
  const factId = (fact: Omit<FreshnessDecisionFactInput, "agentId" | "target">) =>
    freshnessDecisionFactId({
      agentId: input.agentId,
      target: input.target,
      freshnessContextMode: mode,
      ...fact,
    });
  const plan = await planAgentSend(freshness, input, factId);
  if ("state" in plan) return plan;
  const advanced =
    plan.advanceTo !== undefined ? await advance(freshness, plan.advanceTo) : undefined;
  const sent = await executeAgentSendMessage(dependencies.sender, input);
  return {
    state: "sent",
    decision: plan.decision,
    reason: plan.reason,
    messageId: sent.messageId,
    pendingMentionActions: sent.pendingMentionActions,
    unresolvedMentionHandles: sent.unresolvedMentionHandles,
    producerFactId: await factId({ decision: plan.decision, reason: plan.reason, ...plan.fact }),
    ...(advanced !== undefined ? { seenUpToSeq: advanced } : {}),
    ...(plan.recentUnread ? { recentUnread: plan.recentUnread } : {}),
  };
}

/** The send's freshness decision: a held result, or how the send goes through. */
async function planAgentSend(
  freshness: AgentTargetFreshness | undefined,
  input: AgentSendMessageInput,
  factId: (fact: Omit<FreshnessDecisionFactInput, "agentId" | "target">) => Promise<string>,
): Promise<(AgentSendMessageResult & { state: "held" }) | ForwardPlan> {
  const withheld = input.freshnessContextMode === "withheld";
  // Raft: the Agent reports the boundary it has already reviewed; the server advances its own
  // read-through to it (monotone) and uses the advanced value as the freshness boundary.
  let seen = 0;
  if (input.seenUpToSeq !== undefined) {
    if (!freshness?.advanceReadThrough)
      throw new Error("Agent read-through advancement is unavailable");
    seen = await freshness.advanceReadThrough(input.seenUpToSeq);
  }
  // What lies at or below that boundary, and what the Agent was shown one by one, is seen in either
  // mode: the mode decides what a hold presents, not what the Agent has already seen. With no
  // boundary, pending context starts above the Agent's own latest message.
  const pendingBoundary = seen || undefined;
  const excluded = input.seenExactSeqs?.length ? input.seenExactSeqs : undefined;
  const unconsumed = (await freshness?.readPending?.(pendingBoundary, excluded)) ?? [];
  // Raft (`planAgentInboxSideEffect`): `continueAnyway` is the Agent's explicit decision to send
  // anyway (`--send-draft --anyway`). It short-circuits every hold and is never refused — there is
  // no "denied" outcome in Raft's contract.
  if (input.continueAnyway)
    return {
      decision: "bypass",
      reason: "continue_anyway",
      fact: { modelSeenSeq: seen || undefined },
      recentUnread: withheld ? [] : unconsumed.slice(-HELD_CONTEXT_LIMIT),
    };
  // Unconsumed context for this exact target -> `local_hold` over the unconsumed messages only; the
  // held boundary is their newest (`heldBoundary`, 898685).
  if (unconsumed.length > 0) {
    const heldMessages = withheld ? [] : unconsumed.slice(-HELD_CONTEXT_LIMIT);
    // The inline window is bounded for display, so the true newer count comes from the repository's
    // unbounded count in *both* modes; without that seam the window's length is all we know and
    // `omittedMessageCount` stays 0.
    const newMessageCount =
      (await freshness?.countPending?.(pendingBoundary, excluded)) ?? unconsumed.length;
    const seenUpToSeq = maxSequence(unconsumed);
    return {
      state: "held",
      decision: "local_hold",
      reason: "exact_target_pending",
      producerFactId: await factId({
        decision: "local_hold",
        reason: "exact_target_pending",
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
  // Pending context the Agent had all been shown (898650-898676): forward, and advance the boundary
  // over it when a boundary already known reaches its newest message.
  //
  // CoForge difference: Raft's known boundary is the client's alone (the Agent's reported
  // `seenUpToSeq` and its daemon's ledger, `maxKnownContiguousBoundary`, 898778). Here the server's
  // own read-through counts too, which the `check` that showed these messages already moved (the
  // drain is ack-on-drain). That is what lets the steady "notified → check → send" loop advance the
  // boundary, so the Agent's exact set stays small instead of growing to its 2500 cap; and it is
  // safe because the drain already confirmed the Agent was shown those messages.
  const pendingMaxSeq = excluded
    ? ((await freshness?.maxPendingSequence?.(pendingBoundary)) ?? 0)
    : 0;
  if (pendingMaxSeq > 0) {
    const known = Math.max(seen, (await freshness?.readThrough?.()) ?? 0);
    return {
      decision: "forward",
      reason: "exact_target_pending_already_seen",
      fact: {
        pendingMaxSeq,
        modelSeenSeq: known || undefined,
        heldMessageCount: 0,
        omittedMessageCount: 0,
      },
      advanceTo: known >= pendingMaxSeq ? pendingMaxSeq : undefined,
    };
  }
  // No pending context and a boundary (898722-898735): forward at that boundary.
  if (seen > 0)
    return { decision: "forward", reason: "model_seen_boundary", fact: { modelSeenSeq: seen } };
  // A first touch (`planFirstTouchRecentContext`): no boundary at all. Raft loads the target's
  // recent context only for a presented send (`shouldLoadRecent`, 900063), never a withheld one.
  const recent =
    !withheld && freshness?.readRecent
      ? await freshness.readRecent(HELD_CONTEXT_LIMIT, excluded)
      : undefined;
  if (recent?.maxSequence !== undefined) {
    const recentMaxSeq = recent.maxSequence;
    // Every recent message was already seen: forward and advance the boundary over the window.
    if (recent.unseen.length === 0)
      return {
        decision: "forward",
        reason: "target_first_touch_recent_context_already_seen",
        fact: {
          pendingMaxSeq: recentMaxSeq,
          modelSeenSeq: recentMaxSeq,
          heldMessageCount: 0,
          omittedMessageCount: 0,
        },
        advanceTo: recentMaxSeq,
      };
    // `syncing_hold` over the unconsumed messages; the notice's boundary is the whole window's
    // newest, which is what the Agent consumes by reading it (898880-898898).
    const heldMessages = recent.unseen.slice(-HELD_CONTEXT_LIMIT);
    return {
      state: "held",
      decision: "syncing_hold",
      reason: "target_first_touch_recent_context",
      producerFactId: await factId({
        decision: "syncing_hold",
        reason: "target_first_touch_recent_context",
        pendingMaxSeq: maxSequence(recent.unseen),
        heldMessageCount: heldMessages.length,
        omittedMessageCount: recent.unseen.length - heldMessages.length,
      }),
      availableActions: HELD_SEND_AVAILABLE_ACTIONS,
      continueAnywaySuggested: (input.draftReholdCount ?? 0) >= 1,
      heldMessages,
      newMessageCount: recent.unseen.length,
      shownMessageCount: heldMessages.length,
      omittedMessageCount: recent.unseen.length - heldMessages.length,
      seenUpToSeq: recentMaxSeq,
    };
  }
  return { decision: "forward", reason: "no_exact_target_pending_or_recent_context", fact: {} };
}

/** Raft's consume effect on the server: the read-through advances over messages the Agent has
 * seen, and the result tells the daemon the boundary it reached. */
async function advance(
  freshness: AgentTargetFreshness | undefined,
  sequence: number,
): Promise<number | undefined> {
  if (!freshness?.advanceReadThrough) return undefined;
  const reached = await freshness.advanceReadThrough(sequence);
  return reached > 0 ? reached : undefined;
}

function maxSequence(messages: readonly { sequence: number }[]): number {
  let max = 0;
  for (const message of messages) if (message.sequence > max) max = message.sequence;
  return max;
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
  const result = await repository.drainAgentEvents(scope.workspaceId, scope.agentId, limit, target);
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
