import type {
  AgentMessageDelivery,
  AgentMessageDeliveryAck,
  AgentRecoveryMessage,
} from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import { isChannelMessageTarget } from "@lrm/coforge-sdk/internal";
import type { AgentProcessManager } from "../agent-runtime/agent-process-manager";

const logger = getLogger(["coforge", "daemon", "message-attention"]);

export type MessageAttention = Readonly<{
  target: string;
  pendingCount: number;
  firstPendingSequence: number;
  latestSequence: number;
  latestSender?: string;
  flags: readonly string[];
}>;

/**
 * Delivery and message ids remembered per Agent for duplicate suppression. The
 * oldest are forgotten first; a redelivery older than this window is treated
 * as new, which only costs one extra inbox notice.
 */
const REMEMBERED_DELIVERIES = 4096;

/** Daemon-owned volatile attention and model-visible sequence index. */
export class AgentMessageAttentionIndex {
  readonly #generations = new Map<
    string,
    {
      seenDeliveryIds: Set<string>;
      seenMessageIds: Set<string>;
      notified: Set<string>;
      notificationAttempts: Map<string, Promise<void>>;
    }
  >();
  readonly #attention = new Map<string, Map<string, MessageAttention>>();
  readonly #modelSeen = new Map<string, Map<string, number>>();
  readonly #pendingSequences = new Map<string, Map<string, Set<number>>>();
  readonly #readContext = new Map<string, Map<string, number>>();
  readonly #readContextCounters = new Map<string, number>();
  readonly #workspaceId: string;
  readonly #runtimes: Pick<AgentProcessManager, "session">;

  constructor(
    workspaceId: string,
    runtimes: Pick<AgentProcessManager, "session">,
    private readonly sendAck: (ack: AgentMessageDeliveryAck) => Promise<void>,
    private readonly messageReceived: (agentId: string) => void = () => {},
    /**
     * The daemon-owned delivery queue (ADR 0048, `agent-delivery-queue.ts`). `shouldHold` decides
     * whether this delivery must wait rather than reach `AgentSession.notify` now; `enqueue`
     * records it as held once this class has already updated its own attention/dedupe
     * bookkeeping for it. `busy` marks the Agent mid-turn — called synchronously, right before
     * every `session.notify` call this class makes, so a second delivery decided upon before the runtime has
     * emitted any event of its own still sees the Agent as busy. Defaults to never holding and a
     * no-op `busy`, so every existing caller and test observes the prior immediate-notify
     * behavior unchanged.
     */
    private readonly hold: {
      shouldHold(agentId: string): boolean;
      enqueue(agentId: string, message: AgentMessageDelivery): void;
      busy(agentId: string): void;
    } = { shouldHold: () => false, enqueue: () => {}, busy: () => {} },
  ) {
    this.#workspaceId = workspaceId;
    this.#runtimes = runtimes;
  }

  async receive(message: AgentMessageDelivery): Promise<void> {
    if (message.workspaceId !== this.#workspaceId)
      throw new Error("agent message targets another Workspace");
    if (
      !message.conversationId ||
      !message.agentId ||
      !message.messageId ||
      !message.body ||
      !message.target ||
      (!message.target.startsWith("@") && !isChannelMessageTarget(message.target)) ||
      message.target.length < 2 ||
      message.sequence < 1
    )
      throw new Error("invalid agent message scope");
    const generation = this.#generation(message.agentId);
    if (generation.seenDeliveryIds.has(message.deliveryId)) {
      if (!generation.notified.has(message.deliveryId)) {
        if (this.hold.shouldHold(message.agentId)) {
          this.hold.enqueue(message.agentId, message);
          return;
        }
        const attempt = generation.notificationAttempts.get(message.deliveryId);
        await (attempt ?? this.#notify(message));
        if (this.#generations.get(message.agentId) !== generation) return;
      }
      await this.sendAck({
        ...message,
        method: "agent:deliver:ack",
        requestId: message.requestId,
      });
      return;
    }
    this.#remember(generation, message.deliveryId);
    const target = message.target;
    if (this.modelSeenSequence(message.agentId, target) >= message.sequence) {
      await this.sendAck({
        ...message,
        method: "agent:deliver:ack",
        requestId: message.requestId,
      });
      return;
    }
    const latestSender =
      message.latestSender === "system" ||
      (message.latestSender?.startsWith("@") && message.latestSender.length > 1)
        ? message.latestSender
        : undefined;
    const byTarget = this.#attention.get(message.agentId) ?? new Map<string, MessageAttention>();
    const previous = byTarget.get(target);
    const pendingByTarget =
      this.#pendingSequences.get(message.agentId) ?? new Map<string, Set<number>>();
    const pending = pendingByTarget.get(target) ?? new Set<number>();
    pending.add(message.sequence);
    pendingByTarget.set(target, pending);
    this.#pendingSequences.set(message.agentId, pendingByTarget);
    const current = {
      target,
      pendingCount: (previous?.pendingCount ?? 0) + 1,
      firstPendingSequence: previous?.firstPendingSequence ?? message.sequence,
      latestSequence: Math.max(previous?.latestSequence ?? 0, message.sequence),
      ...(latestSender ? { latestSender } : {}),
      flags: [isChannelMessageTarget(target) ? "channel" : target.includes(":") ? "thread" : "dm"],
    };
    byTarget.set(target, current);
    this.#attention.set(message.agentId, byTarget);
    if (this.hold.shouldHold(message.agentId)) {
      this.hold.enqueue(message.agentId, message);
      return;
    }
    await this.#notify(message, current);
    if (this.#generations.get(message.agentId) !== generation) return;
    await this.sendAck({ ...message, method: "agent:deliver:ack", requestId: message.requestId });
  }

  /**
   * Delivers every notice `AgentDeliveryQueue` held for `agentId` (ADR 0048), oldest first, as
   * one call to `AgentSession.notify` once the Agent is idle — the daemon core is the only
   * caller, right after `AgentDeliveryQueue.idle`/`release` hands back what it drained. `receive`
   * already recorded each held delivery's attention while it was held, so `#notify`'s existing
   * coalesced-notice wording (built from that live attention) reads exactly as it would have for
   * the most recent one, had it not been held. ACKs every held delivery only once that single
   * notice is accepted — never on failure, so an un-acked delivery stays safe to hold or
   * redeliver.
   */
  async flush(agentId: string, held: readonly AgentMessageDelivery[]): Promise<void> {
    if (!held.length) return;
    const generation = this.#generation(agentId);
    await this.#notify(held[held.length - 1]!);
    if (this.#generations.get(agentId) !== generation) return;
    for (const message of held)
      await this.sendAck({ ...message, method: "agent:deliver:ack", requestId: message.requestId });
  }

  async recover(
    agentId: string,
    messages: readonly AgentRecoveryMessage[],
    unreadSummary: Readonly<Record<string, number>>,
  ): Promise<void> {
    const generation = this.#generation(agentId);
    const session = this.#runtimes.session(agentId);
    if (!session?.notify) throw new Error("Agent session cannot receive a wakeup notice");
    const currentAttention = this.#attention.get(agentId) ?? new Map<string, MessageAttention>();
    const byTarget = new Map(currentAttention);
    const recoveredTargets = new Set<string>();
    const suppliedTargets = new Set<string>();
    const recoveredCountByTarget = new Map<string, number>();
    const recoveredMessages: AgentRecoveryMessage[] = [];
    for (const message of [...messages].sort(
      (left, right) =>
        left.conversationId.localeCompare(right.conversationId) || left.sequence - right.sequence,
    )) {
      if (
        !message.messageId ||
        !message.deliveryId ||
        !message.conversationId ||
        !message.body ||
        (!message.target.startsWith("@") && !isChannelMessageTarget(message.target)) ||
        message.sequence < 1
      )
        throw new Error("invalid Agent recovery message");
      suppliedTargets.add(message.target);
      if (
        generation.seenDeliveryIds.has(message.deliveryId) ||
        generation.seenMessageIds.has(message.messageId)
      )
        continue;
      recoveredMessages.push(message);
      recoveredTargets.add(message.target);
      recoveredCountByTarget.set(
        message.target,
        (recoveredCountByTarget.get(message.target) ?? 0) + 1,
      );
      const previous = byTarget.get(message.target);
      byTarget.set(message.target, {
        target: message.target,
        pendingCount: (previous?.pendingCount ?? 0) + 1,
        firstPendingSequence: Math.min(
          previous?.firstPendingSequence ?? message.sequence,
          message.sequence,
        ),
        latestSequence: Math.max(previous?.latestSequence ?? 0, message.sequence),
        ...(message.latestSender ? { latestSender: message.latestSender } : {}),
        flags: [
          isChannelMessageTarget(message.target)
            ? "channel"
            : message.target.includes(":")
              ? "thread"
              : "dm",
        ],
      });
    }
    const summaryOnly = Object.entries(unreadSummary).filter(
      ([target, count]) =>
        !suppliedTargets.has(target) &&
        (target.startsWith("@") || isChannelMessageTarget(target)) &&
        count > 0,
    );
    if (!recoveredTargets.size && !summaryOnly.length) return;
    const lines = recoveredMessages
      .filter((message) => !isChannelMessageTarget(message.target))
      .map(
        (message) =>
          `[target=${message.target} msg=${message.messageId.slice(0, 8)} seq=${message.sequence}] ${message.latestSender}: ${message.body}`,
      );
    const instructions = Object.entries(unreadSummary)
      .filter(
        ([target, count]) =>
          recoveredTargets.has(target) &&
          (target.startsWith("@") || isChannelMessageTarget(target)) &&
          count > (recoveredCountByTarget.get(target) ?? 0),
      )
      .map(
        ([target]) =>
          `Run \`coforge message read --target ${isChannelMessageTarget(target) ? `"${target}"` : target}\` to read additional messages.`,
      );
    for (const [target, count] of summaryOnly)
      instructions.push(
        `${target} has ${count} unread message${count === 1 ? "" : "s"}; run \`coforge message read --target ${isChannelMessageTarget(target) ? `"${target}"` : target}\` to read them.`,
      );
    for (const [target, count] of recoveredCountByTarget) {
      if (isChannelMessageTarget(target))
        instructions.push(
          `${target} has ${count} pending notification${count === 1 ? "" : "s"}. Run \`coforge message check\` to read pending messages. Use \`coforge channel mute --target "${target}"\` to stop future ordinary notifications; human @mentions still notify you.`,
        );
    }
    const concrete = lines.length
      ? `${lines.length === 1 ? "New message received:" : "New messages received:"}\n\n${lines.join("\n")}\n\nRespond as appropriate. Complete all your work before stopping.`
      : "New messages received:";
    // ADR 0048: same synchronous-busy rule as `#notify` — this is also a `session.notify` call.
    this.hold.busy(agentId);
    await session.notify(
      `${concrete}${instructions.length ? `\n\n${instructions.join("\n")}` : ""}`,
    );
    if (this.#generations.get(agentId) !== generation) return;
    this.#attention.set(agentId, byTarget);
    for (const message of recoveredMessages) {
      this.#remember(generation, message.deliveryId, message.messageId);
      generation.notified.add(message.deliveryId);
      if (isChannelMessageTarget(message.target)) {
        const byTarget = this.#pendingSequences.get(agentId) ?? new Map<string, Set<number>>();
        const pending = byTarget.get(message.target) ?? new Set<number>();
        pending.add(message.sequence);
        byTarget.set(message.target, pending);
        this.#pendingSequences.set(agentId, byTarget);
      } else this.recordModelSeen(agentId, message.target, message.sequence);
    }
    if (recoveredMessages.length) this.messageReceived(agentId);
  }

  #notify(message: AgentMessageDelivery, attention?: MessageAttention): Promise<void> {
    const generation = this.#generation(message.agentId);
    const session = this.#runtimes.session(message.agentId);
    if (!session?.notify)
      return Promise.reject(new Error("Agent session cannot receive a wakeup notice"));
    if (!message.target) return Promise.reject(new Error("delivery target is missing"));
    // ADR 0048: mark busy synchronously, in the same tick as this decision to write to the
    // session — before the next queued input for this Agent can be drained and see a stale
    // "not busy yet" state.
    this.hold.busy(message.agentId);
    const current = attention ?? this.#attention.get(message.agentId)?.get(message.target);
    const pendingCount = current?.pendingCount ?? 1;
    const totalPendingCount = [...(this.#attention.get(message.agentId)?.values() ?? [])].reduce(
      (total, item) => total + item.pendingCount,
      0,
    );
    const target = current?.target ?? message.target;
    const latestSender = current?.latestSender ? ` · latest sender ${current.latestSender}` : "";
    const notice = `[CoForge inbox notice:
Inbox update: ${totalPendingCount} unread message${totalPendingCount === 1 ? "" : "s"} total; 1 changed target
${target}  pending: ${pendingCount} message${pendingCount === 1 ? "" : "s"}${latestSender}
Run \`coforge message check\` to read pending messages.]`;
    const notification = Promise.resolve()
      .then(() => session.notify!(notice))
      .then(() => {
        if (this.#generations.get(message.agentId) === generation) {
          generation.notified.add(message.deliveryId);
          this.messageReceived(message.agentId);
        }
        logger.info("Agent accepted inbox notice", {
          event: "agent.inbox_notice.accepted",
          request_id: message.requestId,
          workspace_id: message.workspaceId,
          agent_id: message.agentId,
          target_count: 1,
          pending_count: pendingCount,
          total_pending_count: totalPendingCount,
          outcome: "ok",
        });
      })
      .catch((error: unknown) => {
        logger.error("Agent rejected inbox notice", {
          event: "agent.inbox_notice.rejected",
          request_id: message.requestId,
          workspace_id: message.workspaceId,
          agent_id: message.agentId,
          target_count: 1,
          pending_count: pendingCount,
          total_pending_count: totalPendingCount,
          error_code: error instanceof Error ? error.name : "UnknownError",
          outcome: "failed",
        });
        throw error;
      })
      .finally(() => {
        if (this.#generations.get(message.agentId) === generation)
          generation.notificationAttempts.delete(message.deliveryId);
      });
    generation.notificationAttempts.set(message.deliveryId, notification);
    return notification;
  }

  #remember(
    generation: {
      seenDeliveryIds: Set<string>;
      seenMessageIds: Set<string>;
      notified: Set<string>;
      notificationAttempts: Map<string, Promise<void>>;
    },
    deliveryId: string,
    messageId?: string,
  ): void {
    if (generation.seenDeliveryIds.size >= REMEMBERED_DELIVERIES) {
      const oldest = generation.seenDeliveryIds.values().next().value!;
      generation.seenDeliveryIds.delete(oldest);
      generation.notified.delete(oldest);
      generation.notificationAttempts.delete(oldest);
    }
    generation.seenDeliveryIds.add(deliveryId);
    if (messageId === undefined) return;
    if (generation.seenMessageIds.size >= REMEMBERED_DELIVERIES)
      generation.seenMessageIds.delete(generation.seenMessageIds.values().next().value!);
    generation.seenMessageIds.add(messageId);
  }

  #generation(agentId: string) {
    const existing = this.#generations.get(agentId);
    if (existing) return existing;
    const generation = {
      seenDeliveryIds: new Set<string>(),
      seenMessageIds: new Set<string>(),
      notified: new Set<string>(),
      notificationAttempts: new Map<string, Promise<void>>(),
    };
    this.#generations.set(agentId, generation);
    return generation;
  }

  check(agentId: string): MessageAttention[] {
    return [...(this.#attention.get(agentId)?.values() ?? [])];
  }

  modelSeenSequence(agentId: string, target: string): number {
    return this.#modelSeen.get(agentId)?.get(target) ?? 0;
  }

  recordModelSeen(agentId: string, target: string, sequence: number): void {
    if (!Number.isInteger(sequence) || sequence < 1) return;
    const byTarget = this.#modelSeen.get(agentId) ?? new Map<string, number>();
    byTarget.set(target, Math.max(byTarget.get(target) ?? 0, sequence));
    this.#modelSeen.set(agentId, byTarget);

    const attention = this.#attention.get(agentId)?.get(target);
    if (!attention || sequence < attention.firstPendingSequence) return;
    if (sequence >= attention.latestSequence) {
      this.clear(agentId, target);
      return;
    }
    const pending = this.#pendingSequences.get(agentId)?.get(target);
    if (!pending) return;
    for (const value of pending) if (value <= sequence) pending.delete(value);
    this.#attention.get(agentId)?.set(target, {
      ...attention,
      pendingCount: pending.size,
      firstPendingSequence: Math.min(...pending),
    });
  }

  /**
   * Records that the Agent just consumed messages for `target` (a `read`, a `check`/events drain
   * page, or the held-context read inside `send`), under a per-Agent monotonically increasing
   * counter. Volatile, like `modelSeen`; used only by the `--target-confirmed` guard to compare how
   * recently a thread was read against how recently its parent target was read.
   */
  recordReadContext(agentId: string, target: string): void {
    const order = (this.#readContextCounters.get(agentId) ?? 0) + 1;
    this.#readContextCounters.set(agentId, order);
    const byTarget = this.#readContext.get(agentId) ?? new Map<string, number>();
    byTarget.set(target, order);
    this.#readContext.set(agentId, byTarget);
  }

  /** The most recently read context order for `target`, or `undefined` if never recorded. */
  readOrder(agentId: string, target: string): number | undefined {
    return this.#readContext.get(agentId)?.get(target);
  }

  /** The most recently read thread target rooted under `parentTarget`, or `undefined` if none. */
  latestThreadReadUnderParent(
    agentId: string,
    parentTarget: string,
  ): { target: string; order: number } | undefined {
    const byTarget = this.#readContext.get(agentId);
    if (!byTarget) return undefined;
    const prefix = `${parentTarget}:`;
    let latest: { target: string; order: number } | undefined;
    for (const [target, order] of byTarget)
      if (target.startsWith(prefix) && (!latest || order > latest.order))
        latest = { target, order };
    return latest;
  }

  clearAgent(agentId: string): void {
    this.#generations.delete(agentId);
    this.#attention.delete(agentId);
    this.#modelSeen.delete(agentId);
    this.#pendingSequences.delete(agentId);
    this.#readContext.delete(agentId);
    this.#readContextCounters.delete(agentId);
  }

  clear(agentId: string, target: string): void {
    this.#pendingSequences.get(agentId)?.delete(target);
    const byTarget = this.#attention.get(agentId);
    byTarget?.delete(target);
    if (byTarget?.size === 0) this.#attention.delete(agentId);
  }

  clearThrough(agentId: string, target: string, sequence: number): void {
    const attention = this.#attention.get(agentId)?.get(target);
    if (!attention || attention.latestSequence <= sequence) this.clear(agentId, target);
  }
}
