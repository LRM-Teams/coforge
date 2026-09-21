import type {
  AgentMessageDelivery,
  AgentMessageDeliveryAck,
  AgentRecoveryMessage,
  MessageSenderKind,
} from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import {
  AGENT_MESSAGE_ACK_METHOD,
  isChannelMessageTarget,
  isValidMessageSender,
  renderMessageSender,
} from "@lrm/coforge-sdk/internal";
import type { AgentProcessManager } from "../agent-runtime/agent-process-manager";
import { HELD_CONTEXT_LIMIT } from "./agent-inbox-freshness";

const logger = getLogger(["coforge", "daemon", "message-attention"]);

export type MessageAttention = Readonly<{
  target: string;
  pendingCount: number;
  firstPendingSequence: number;
  latestSequence: number;
  latestSenderKind?: MessageSenderKind;
  latestSenderHandle?: string;
  flags: readonly string[];
}>;

/**
 * Delivery and message ids remembered per Agent for duplicate suppression. The
 * oldest are forgotten first; a redelivery older than this window is treated
 * as new, which only costs one extra inbox notice.
 */
const REMEMBERED_DELIVERIES = 4096;

/** How many of the newest unreviewed deliveries per target the index keeps for a locally decided
 * freshness hold to show: exactly Raft's `DEFAULT_HELD_CONTEXT_LIMIT` (`HELD_CONTEXT_LIMIT` in
 * `agent-inbox-freshness.ts`), because the hold shows the newest that many and no more — and
 * anything older is consumed by the same frontier anyway. No invented slack. */
const PENDING_WINDOW_LIMIT = HELD_CONTEXT_LIMIT;

/** One unreviewed delivery plus the moment this daemon learned about it. Deliveries carry no
 * message timestamp of their own (only the server knows when a message was written), so the
 * arrival time is what a locally built preview can honestly show. */

/** The fields `#localViewRows` reads — a live delivery or a recovery message. */
type LocalViewItem = {
  target?: string;
  messageId: string;
  latestSenderKind?: MessageSenderKind;
  latestSenderHandle?: string;
};

export type PendingWindowEntry = { delivery: AgentMessageDelivery; receivedAt: number };

/**
 * Validates a `(kind, handle)` pair before it can reach a model-visible notice (ADR 0052,
 * decision D): the kind must be one of the closed values and the handle must match the public
 * handle grammar (or be empty for `system`). This replaces the former regex guard on a single
 * composed string — a newline can no longer reach a notice through a sender name, because the
 * handle is matched against the handle grammar and the kind against the closed set separately.
 * A rejected pair is logged by name and dropped rather than printed; it never fails the delivery
 * it came with.
 */
function printableSender(
  kind: MessageSenderKind | undefined,
  handle: string | undefined,
): { kind: MessageSenderKind; handle: string } | undefined {
  if (kind === undefined) return undefined;
  if (!isValidMessageSender(kind, handle ?? "")) {
    logger.warn("rejected an unprintable message sender", {
      event: "message.sender_rejected",
      sender_kind: kind,
    });
    return undefined;
  }
  return { kind, handle: handle ?? "" };
}

/** Distinct messages in a delivery list. The same message can appear more than once: a request
 * retried while held is enqueued again so both attempts stay ACK-able, and a redelivery arriving
 * after the dedupe window is a second delivery of one message. A notice counts messages. */
function countDistinctMessages(deliveries: readonly AgentMessageDelivery[]): number {
  return new Set(deliveries.map((delivery) => delivery.messageId)).size;
}

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
  /** The newest unreviewed deliveries per Agent and target, with the moment the daemon learned
   * about each. Kept so a locally decided freshness hold can show the Agent the same bounded
   * window the server's hold would have shown — and so the hold can count that window as
   * reviewed, which is what lets a resend through instead of holding it again. Bounded by
   * `PENDING_WINDOW_LIMIT`; pruned as the boundary advances and dropped with the Agent. */
  readonly #pendingWindow = new Map<string, Map<string, PendingWindowEntry[]>>();
  /** The newest sequence ever seen per (agent, target), reviewed or not. Unlike `#attention` (which
   * is cleared once the boundary catches up) this is only forgotten with the Agent, so a settled
   * target still reports the context it once held — the daemon's own answer to "is there anything
   * here for this target at all", which its freshness decision needs. */
  readonly #latestKnown = new Map<string, Map<string, number>>();
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
      /** The deliveries held for this Agent that it has not been shown yet. The notice counts
       * these, so its number is always a count of messages the daemon is holding right now rather
       * than a running total it would have to invalidate later. Concrete deliveries rather than a
       * number because the same message can be enqueued more than once — one request retried
       * while held keeps both attempts for ACK bookkeeping — and a notice must count messages,
       * not attempts. Optional: a composition without a delivery queue holds nothing. */
      queued?(agentId: string): readonly AgentMessageDelivery[];
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
        method: AGENT_MESSAGE_ACK_METHOD,
        requestId: message.requestId,
      });
      return;
    }
    this.#remember(generation, message.deliveryId);
    const target = message.target;
    if (this.modelSeenSequence(message.agentId, target) >= message.sequence) {
      await this.sendAck({
        ...message,
        method: AGENT_MESSAGE_ACK_METHOD,
        requestId: message.requestId,
      });
      return;
    }
    const latestSender = printableSender(message.latestSenderKind, message.latestSenderHandle);
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
      ...(latestSender
        ? { latestSenderKind: latestSender.kind, latestSenderHandle: latestSender.handle }
        : {}),
      flags: [isChannelMessageTarget(target) ? "channel" : target.includes(":") ? "thread" : "dm"],
    };
    byTarget.set(target, current);
    this.#attention.set(message.agentId, byTarget);
    this.#recordLatest(message.agentId, target, message.sequence);
    this.#recordPendingWindow(message.agentId, target, message);
    if (this.hold.shouldHold(message.agentId)) {
      this.hold.enqueue(message.agentId, message);
      return;
    }
    await this.#notify(message, current);
    if (this.#generations.get(message.agentId) !== generation) return;
    await this.sendAck({
      ...message,
      method: AGENT_MESSAGE_ACK_METHOD,
      requestId: message.requestId,
    });
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
    // One notice for the whole coalesced batch, carrying the batch itself: the queue is per Agent,
    // so a batch legitimately spans channels, DMs and threads, and each target needs its own line.
    await this.#notify(held[held.length - 1]!, undefined, held);
    if (this.#generations.get(agentId) !== generation) return;
    for (const message of held)
      await this.sendAck({
        ...message,
        method: AGENT_MESSAGE_ACK_METHOD,
        requestId: message.requestId,
      });
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
        message.sequence < 1 ||
        !isValidMessageSender(message.latestSenderKind, message.latestSenderHandle)
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
      const previous = byTarget.get(message.target);
      byTarget.set(message.target, {
        target: message.target,
        pendingCount: (previous?.pendingCount ?? 0) + 1,
        firstPendingSequence: Math.min(
          previous?.firstPendingSequence ?? message.sequence,
          message.sequence,
        ),
        latestSequence: Math.max(previous?.latestSequence ?? 0, message.sequence),
        latestSenderKind: message.latestSenderKind,
        latestSenderHandle: message.latestSenderHandle,
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
    // Recovery is a wakeup, not a second copy of the bodies: the same messages will come back
    // through `coforge message check`. DM and channel share `#localViewRows` (one target per
    // line, no body). `recordModelSeen` is not advanced here — the server cursor has not moved,
    // and `check` is what advances both.
    const rows = [
      ...this.#localViewRows(recoveredMessages, []),
      ...summaryOnly.map(
        ([target, count]) => `${target}  new: ${count} message${count === 1 ? "" : "s"}`,
      ),
    ];
    const totalCount =
      recoveredMessages.length + summaryOnly.reduce((sum, [, count]) => sum + count, 0);
    const notice = `[CoForge inbox notice (restart recovery):
Inbox update: ${totalCount} message${totalCount === 1 ? "" : "s"} delivered or held for you
${rows.join("\n")}
Run \`coforge message check\` (or \`check --target @x\`) to read pending messages.]`;
    // ADR 0048: same synchronous-busy rule as `#notify` — this is also a `session.notify` call.
    this.hold.busy(agentId);
    await session.notify(notice);
    if (this.#generations.get(agentId) !== generation) return;
    this.#attention.set(agentId, byTarget);
    for (const message of recoveredMessages) {
      this.#recordLatest(agentId, message.target, message.sequence);
      this.#remember(generation, message.deliveryId, message.messageId);
      generation.notified.add(message.deliveryId);
      const pendingByTarget = this.#pendingSequences.get(agentId) ?? new Map<string, Set<number>>();
      const pending = pendingByTarget.get(message.target) ?? new Set<number>();
      pending.add(message.sequence);
      pendingByTarget.set(message.target, pending);
      this.#pendingSequences.set(agentId, pendingByTarget);
    }
    if (recoveredMessages.length) this.messageReceived(agentId);
  }

  /**
   * One line per target, in the order the targets first appear: what this notice announces (`new`)
   * and what stays queued for this Agent (`held`). The delivery queue is per Agent (ADR 0048), so
   * a coalesced flush can mix a channel, a DM and a thread; attributing the whole batch to the
   * last delivery's target would hide the others.
   *
   * Both sets appear because the headline counts both. A headline that summed announced and queued
   * while the lines showed only the announced ones left the reader unable to tell where the rest
   * were, which is the same kind of unexplainable number this change exists to remove.
   */
  #localViewRows(announced: readonly LocalViewItem[], queued: readonly LocalViewItem[]): string[] {
    const announcedIds = new Set(announced.map((delivery) => delivery.messageId));
    type Row = {
      newIds: Set<string>;
      heldIds: Set<string>;
      latestSenderKind?: MessageSenderKind;
      latestSenderHandle?: string;
    };
    const byTarget = new Map<string, Row>();
    const rowFor = (target: string) => {
      const existing = byTarget.get(target);
      if (existing) return existing;
      const created: Row = {
        newIds: new Set<string>(),
        heldIds: new Set<string>(),
      };
      byTarget.set(target, created);
      return created;
    };
    for (const delivery of announced) {
      // `receive` rejects a delivery without a target before it can be held, so this only narrows
      // the wire type; a targetless delivery has no line to appear on either way.
      if (!delivery.target) continue;
      const row = rowFor(delivery.target);
      row.newIds.add(delivery.messageId);
      const sender = printableSender(delivery.latestSenderKind, delivery.latestSenderHandle);
      if (sender) {
        row.latestSenderKind = sender.kind;
        row.latestSenderHandle = sender.handle;
      }
    }
    for (const delivery of queued) {
      if (!delivery.target || announcedIds.has(delivery.messageId)) continue;
      const row = rowFor(delivery.target);
      row.heldIds.add(delivery.messageId);
      const sender = printableSender(delivery.latestSenderKind, delivery.latestSenderHandle);
      if (sender) {
        row.latestSenderKind = sender.kind;
        row.latestSenderHandle = sender.handle;
      }
    }
    return [...byTarget].map(([target, row]) => {
      const parts: string[] = [];
      if (row.newIds.size)
        parts.push(`new: ${row.newIds.size} message${row.newIds.size === 1 ? "" : "s"}`);
      if (row.heldIds.size)
        parts.push(`held: ${row.heldIds.size} message${row.heldIds.size === 1 ? "" : "s"}`);
      if (row.latestSenderKind !== undefined)
        parts.push(
          `latest sender ${renderMessageSender(row.latestSenderKind, row.latestSenderHandle ?? "")}`,
        );
      return `${target}  ${parts.join(" · ")}`;
    });
  }

  #notify(
    message: AgentMessageDelivery,
    attention?: MessageAttention,
    /** The messages this notice announces: one delivery, or a coalesced flush's whole batch. */
    announced: readonly AgentMessageDelivery[] = [message],
  ): Promise<void> {
    const generation = this.#generation(message.agentId);
    const session = this.#runtimes.session(message.agentId);
    if (!session?.notify)
      return Promise.reject(new Error("Agent session cannot receive a wakeup notice"));
    if (!message.target) return Promise.reject(new Error("delivery target is missing"));
    // ADR 0048: mark busy synchronously, in the same tick as this decision to write to the
    // session — before the next queued input for this Agent can be drained and see a stale
    // "not busy yet" state.
    this.hold.busy(message.agentId);
    void attention;
    // One source of truth. Every number here is a fact the daemon owns right now — the messages
    // it is announcing, plus the ones still queued for this Agent — never a per-target total
    // accumulated across earlier notices, because such a total outlived what the server would
    // hand over and made an already-read message look lost.
    //
    // The wording is bounded by what the daemon can actually establish. It knows what it
    // delivered and what it holds; it does not know the server's read cursor, so it must not say
    // these messages are unread — a delivery notice can race a `check` or `read` that already
    // advanced that cursor. Only those commands answer what is left, and either may answer
    // "nothing".
    const queued = this.hold.queued?.(message.agentId) ?? [];
    const rows = this.#localViewRows(announced, queued);
    const totalCount = countDistinctMessages([...announced, ...queued]);
    const notice = `[CoForge inbox notice:
Inbox update: ${totalCount} message${totalCount === 1 ? "" : "s"} delivered or held for you
${rows.join("\n")}
What the server still has for you is answered only by \`coforge message check\`, or
\`coforge message read --target <target>\`; either may return nothing, because a message can
already have been read. A notice you have not acted on does not establish that there is no work.]`;
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
          target_count: rows.length,
          pending_count: countDistinctMessages(announced),
          total_pending_count: totalCount,
          outcome: "ok",
        });
      })
      .catch((error: unknown) => {
        logger.error("Agent rejected inbox notice", {
          event: "agent.inbox_notice.rejected",
          request_id: message.requestId,
          workspace_id: message.workspaceId,
          agent_id: message.agentId,
          target_count: rows.length,
          pending_count: countDistinctMessages(announced),
          total_pending_count: totalCount,
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

  /** Messages the Agent has not been shown yet for this exact target. A target with no attention
   * entry has none: entries are created by a delivery and cleared once the boundary catches up. */
  pendingMessageCount(agentId: string, target: string): number {
    return this.#attention.get(agentId)?.get(target)?.pendingCount ?? 0;
  }

  /** The newest unreviewed deliveries for `target`, oldest first, at most `limit` of them: the
   * window a locally decided hold presents (Raft's `DEFAULT_HELD_CONTEXT_LIMIT`). */
  pendingWindow(agentId: string, target: string, limit: number): readonly PendingWindowEntry[] {
    const entries = this.#pendingWindow.get(agentId)?.get(target) ?? [];
    return entries.slice(-limit);
  }

  /** The newest sequence this Agent has ever seen for `target`, reviewed or not; 0 means the daemon
   * has never carried anything for it. */
  latestSequence(agentId: string, target: string): number {
    return this.#latestKnown.get(agentId)?.get(target) ?? 0;
  }

  #recordPendingWindow(agentId: string, target: string, delivery: AgentMessageDelivery): void {
    const byTarget = this.#pendingWindow.get(agentId) ?? new Map<string, PendingWindowEntry[]>();
    const entries = byTarget.get(target) ?? [];
    entries.push({ delivery, receivedAt: Date.now() });
    if (entries.length > PENDING_WINDOW_LIMIT)
      entries.splice(0, entries.length - PENDING_WINDOW_LIMIT);
    byTarget.set(target, entries);
    this.#pendingWindow.set(agentId, byTarget);
  }

  #prunePendingWindow(agentId: string, target: string, through: number): void {
    const byTarget = this.#pendingWindow.get(agentId);
    const entries = byTarget?.get(target);
    if (!byTarget || !entries) return;
    const kept = entries.filter((entry) => entry.delivery.sequence > through);
    if (kept.length === 0) byTarget.delete(target);
    else byTarget.set(target, kept);
  }

  #recordLatest(agentId: string, target: string, sequence: number): void {
    if (!Number.isInteger(sequence) || sequence < 1) return;
    const byTarget = this.#latestKnown.get(agentId) ?? new Map<string, number>();
    if ((byTarget.get(target) ?? 0) >= sequence) return;
    byTarget.set(target, sequence);
    this.#latestKnown.set(agentId, byTarget);
  }

  recordModelSeen(agentId: string, target: string, sequence: number): void {
    if (!Number.isInteger(sequence) || sequence < 1) return;
    const byTarget = this.#modelSeen.get(agentId) ?? new Map<string, number>();
    byTarget.set(target, Math.max(byTarget.get(target) ?? 0, sequence));
    this.#modelSeen.set(agentId, byTarget);

    // The window the Agent has now been shown (or the boundary it reported) is reviewed: drop what
    // it covers, so a locally decided hold cannot present the same messages twice.
    this.#prunePendingWindow(agentId, target, sequence);
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
    this.#pendingWindow.delete(agentId);
    this.#latestKnown.delete(agentId);
    this.#readContext.delete(agentId);
    this.#readContextCounters.delete(agentId);
  }

  clear(agentId: string, target: string): void {
    this.#pendingSequences.get(agentId)?.delete(target);
    this.#pendingWindow.get(agentId)?.delete(target);
    const byTarget = this.#attention.get(agentId);
    byTarget?.delete(target);
    if (byTarget?.size === 0) this.#attention.delete(agentId);
  }

  clearThrough(agentId: string, target: string, sequence: number): void {
    const attention = this.#attention.get(agentId)?.get(target);
    if (!attention || attention.latestSequence <= sequence) this.clear(agentId, target);
  }
}
