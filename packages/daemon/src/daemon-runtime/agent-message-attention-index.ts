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
import type { AgentProcessManager } from "#src/agent-runtime/agent-process-manager";
import type { AgentConsumedSeqPort } from "#src/persistence/agent-consumed-seq-store";
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
/** Out-of-order seen message ids remembered per Agent and target; the oldest go first. */
const SEEN_MESSAGE_LIMIT = 1024;

/** How many of the newest unreviewed deliveries per target the index keeps for a locally decided
 * freshness hold to show: exactly Raft's `DEFAULT_HELD_CONTEXT_LIMIT` (`HELD_CONTEXT_LIMIT` in
 * `agent-inbox-freshness.ts`), because the hold shows the newest that many and no more — and
 * anything older is consumed by the same frontier anyway. No invented slack. */
const PENDING_WINDOW_LIMIT = HELD_CONTEXT_LIMIT;

/**
 * Agent-authored parent-channel chatter should not wake other Agents unless it personally
 * @mentions them. Human ordinary channel messages still wake every delivered Agent so each can
 * decide whether to participate.
 */
function shouldWakeForDelivery(message: AgentMessageDelivery): boolean {
  const target = message.target ?? "";
  if (!isChannelMessageTarget(target)) return true;
  if (target.includes(":")) return true;
  if (message.latestSenderKind === "system") return true;
  return !(message.latestSenderKind === "agent" && message.mentionsAgent === false);
}

/** One unreviewed delivery plus the moment this daemon learned about it. Deliveries carry no
 * message timestamp of their own (only the server knows when a message was written), so the
 * arrival time is what a locally built preview can honestly show. */
export type PendingWindowEntry = { delivery: AgentMessageDelivery; receivedAt: number };

/** The fields `#localViewRows` reads — a live delivery or a recovery message. */
type LocalViewItem = {
  target?: string;
  messageId: string;
  sequence?: number;
  latestSenderKind?: MessageSenderKind;
  latestSenderHandle?: string;
};

type LocalViewRow = {
  target: string;
  newIds: Set<string>;
  heldIds: Set<string>;
  latestSenderKind?: MessageSenderKind;
  latestSenderHandle?: string;
};

/**
 * Validates a `(kind, handle)` pair before it can reach a model-visible notice:
 * the kind must be one of the closed values and the handle must match the public
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

/** The fields every delivery must carry before it can touch attention or be acknowledged. */
function hasDeliveryScope(
  message: AgentMessageDelivery,
): message is AgentMessageDelivery & { target: string } {
  return Boolean(
    message.conversationId &&
    message.agentId &&
    message.messageId &&
    message.body &&
    message.target &&
    (message.target.startsWith("@") || isChannelMessageTarget(message.target)) &&
    message.target.length >= 2 &&
    message.sequence >= 1,
  );
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
  /** Messages the Agent was shown one by one, per target, beyond its contiguous frontier: an
   * anchored `read` or a `search` shows messages without moving `#modelSeen`. Volatile, bounded by
   * `SEEN_MESSAGE_LIMIT` per target, and dropped with the Agent. */
  readonly #seenMessageIds = new Map<string, Map<string, Set<string>>>();
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
  /** Raft's `consumed-seqs.json`: the durable copy of `#modelSeen` (the `seq` frontier) and
   * `#readContext` (the `readOrder` each target was last reviewed at). */
  readonly #consumedSeqs?: AgentConsumedSeqPort;
  /** Agents whose durable cursor has already been folded into the maps above. Raft reads the file
   * on every lookup; reading it once per Agent per daemon life is the same answer, minus the
   * syscall in a message loop, and `clearAgent` drops the marker so a re-registered Agent reads it
   * again. */
  readonly #hydrated = new Set<string>();
  readonly #workspaceId: string;
  readonly #runtimes: Pick<AgentProcessManager, "session">;
  readonly #memoryReminders = new Map<string, string>();

  constructor(
    workspaceId: string,
    runtimes: Pick<AgentProcessManager, "session">,
    private readonly sendAck: (ack: AgentMessageDeliveryAck) => Promise<void>,
    private readonly messageReceived: (agentId: string) => void = () => {},
    /**
     * The daemon-owned delivery queue (`agent-delivery-queue.ts`). `shouldHold` decides
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
      /** The Agent's durable consumed cursor (Raft's `consumed-seqs.json`). Without it the index is
       * exactly as volatile as it was: the cursor then only lives as long as this process. */
      consumedSeqs?: AgentConsumedSeqPort;
    } = { shouldHold: () => false, enqueue: () => {}, busy: () => {} },
  ) {
    this.#workspaceId = workspaceId;
    this.#runtimes = runtimes;
    this.#consumedSeqs = hold.consumedSeqs;
  }

  /** Appended once to the next notice; the daemon never edits the Agent's MEMORY.md. */
  setMemoryReminder(agentId: string, text: string): void {
    this.#memoryReminders.set(agentId, text);
  }

  async receive(message: AgentMessageDelivery): Promise<void> {
    if (message.workspaceId !== this.#workspaceId)
      throw new Error("agent message targets another Workspace");
    if (!hasDeliveryScope(message)) throw new Error("invalid agent message scope");
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
    if (this.#consumed(message)) {
      await this.sendAck({
        ...message,
        method: AGENT_MESSAGE_ACK_METHOD,
        requestId: message.requestId,
      });
      return;
    }
    const current = this.#recordAttention(message);
    if (!shouldWakeForDelivery(message)) {
      generation.notified.add(message.deliveryId);
      await this.sendAck({
        ...message,
        method: AGENT_MESSAGE_ACK_METHOD,
        requestId: message.requestId,
      });
      return;
    }
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

  /** Records one delivery the Agent has not been shown yet: its target's attention, pending
   * sequences, newest known sequence, and the window a local hold presents. */
  #recordAttention(message: AgentMessageDelivery & { target: string }): MessageAttention {
    const target = message.target;
    const latestSender = printableSender(message.latestSenderKind, message.latestSenderHandle);
    const byTarget = this.#attention.get(message.agentId) ?? new Map<string, MessageAttention>();

    const previous = byTarget.get(target);
    const pendingByTarget =
      this.#pendingSequences.get(message.agentId) ?? new Map<string, Set<number>>();
    const pending = pendingByTarget.get(target) ?? new Set<number>();
    pending.add(message.sequence);
    pendingByTarget.set(target, pending);
    this.#pendingSequences.set(message.agentId, pendingByTarget);
    const current: MessageAttention = {
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
    return current;
  }

  /**
   * Delivers every notice `AgentDeliveryQueue` held for `agentId`, oldest first, as
   * one call to `AgentSession.notify` once the Agent is idle — the daemon core is the only
   * caller, right after `AgentDeliveryQueue.idle`/`release` hands back what it drained. A delivery
   * held by `receive` already passed its checks and has its attention recorded. One the runtime
   * queued before the Agent's process existed (a wake cooldown, a batched wake) gets `receive`'s
   * treatment here: an already-consumed one is only ACKed, one that never wakes the Agent is
   * recorded and ACKed but not announced, and a malformed one is neither announced nor ACKed.
   * ACKs only once the single notice is accepted (or when nothing needed announcing) — never on
   * failure, so an un-acked delivery stays safe to hold or redeliver.
   */
  async flush(agentId: string, held: readonly AgentMessageDelivery[]): Promise<void> {
    if (!held.length) return;
    const generation = this.#generation(agentId);
    const acknowledged: AgentMessageDelivery[] = [];
    const announced: AgentMessageDelivery[] = [];
    for (const message of held) {
      if (!hasDeliveryScope(message)) continue;
      acknowledged.push(message);
      if (generation.seenDeliveryIds.has(message.deliveryId)) {
        announced.push(message);
        continue;
      }
      this.#remember(generation, message.deliveryId);
      if (this.#consumed(message)) continue;
      this.#recordAttention(message);
      if (shouldWakeForDelivery(message)) announced.push(message);
    }
    // One notice for the whole coalesced batch, carrying the batch itself: the queue is per Agent,
    // so a batch legitimately spans channels, DMs and threads, and each target needs its own line.
    if (announced.length) {
      await this.#notify(announced[announced.length - 1]!, undefined, announced);
      if (this.#generations.get(agentId) !== generation) return;
    }
    for (const message of acknowledged) {
      generation.notified.add(message.deliveryId);
      await this.sendAck({
        ...message,
        method: AGENT_MESSAGE_ACK_METHOD,
        requestId: message.requestId,
      });
    }
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
    const recoveryRows = this.#localViewRows(recoveredMessages, []);
    const rows = [
      ...this.#renderLocalViewRows(recoveryRows.rows),
      ...summaryOnly.map(
        ([target, count]) => `${target}  new: ${count} message${count === 1 ? "" : "s"}`,
      ),
    ];
    const totalCount =
      recoveredMessages.length + summaryOnly.reduce((sum, [, count]) => sum + count, 0);
    const notice = this.#withMemoryReminder(
      agentId,
      `[CoForge inbox notice (restart recovery):
Inbox update: ${totalCount} message${totalCount === 1 ? "" : "s"} delivered or held for you
${rows.join("\n")}
Run \`coforge message check\` to drain pending messages, or \`coforge message read --target @x\` to inspect one target.]`,
    );
    // Same synchronous-busy rule as `#notify` — this is also a `session.notify` call.
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

  #withMemoryReminder(agentId: string, notice: string): string {
    const reminder = this.#memoryReminders.get(agentId);
    if (!reminder) return notice;
    this.#memoryReminders.delete(agentId);
    return `${notice}\n\n${reminder}`;
  }

  /**
   * One line per target, in the order the targets first appear: what this notice announces (`new`)
   * and what stays queued for this Agent (`held`). The delivery queue is per Agent, so
   * a coalesced flush can mix a channel, a DM and a thread; attributing the whole batch to the
   * last delivery's target would hide the others.
   *
   * Both sets appear because the headline counts both. A headline that summed announced and queued
   * while the lines showed only the announced ones left the reader unable to tell where the rest
   * were, which is the same kind of unexplainable number this change exists to remove.
   */
  #localViewRows(
    announced: readonly LocalViewItem[],
    queued: readonly LocalViewItem[],
  ): {
    rows: LocalViewRow[];
    countedIds: Set<string>;
  } {
    const announcedIds = new Set(announced.map((delivery) => delivery.messageId));
    const countedIds = new Set<string>();
    const byTarget = new Map<string, LocalViewRow>();
    const rowFor = (target: string) => {
      const existing = byTarget.get(target);
      if (existing) return existing;
      const created: LocalViewRow = {
        target,
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
      countedIds.add(delivery.messageId);
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
      countedIds.add(delivery.messageId);
      const sender = printableSender(delivery.latestSenderKind, delivery.latestSenderHandle);
      if (sender) {
        row.latestSenderKind = sender.kind;
        row.latestSenderHandle = sender.handle;
      }
    }
    return { rows: [...byTarget.values()], countedIds };
  }

  #renderLocalViewRows(rows: readonly LocalViewRow[]): string[] {
    return rows.map((row) => {
      const parts: string[] = [];
      if (row.newIds.size)
        parts.push(`new: ${row.newIds.size} message${row.newIds.size === 1 ? "" : "s"}`);
      if (row.heldIds.size)
        parts.push(`held: ${row.heldIds.size} message${row.heldIds.size === 1 ? "" : "s"}`);
      if (row.latestSenderKind !== undefined)
        parts.push(
          `latest sender ${renderMessageSender(row.latestSenderKind, row.latestSenderHandle ?? "")}`,
        );
      return `${row.target}  ${parts.join(" · ")}`;
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
    // Mark busy synchronously, in the same tick as this decision to write to the
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
    const view = this.#localViewRows(announced, queued);
    const rows = this.#renderLocalViewRows(view.rows);
    const totalCount = countDistinctMessages([...announced, ...queued]);
    const notice = this.#withMemoryReminder(
      message.agentId,
      `[CoForge inbox notice:
Inbox update: ${totalCount} message${totalCount === 1 ? "" : "s"} delivered or held for you
${rows.join("\n")}
What the server still has for you is answered only by \`coforge message check\`, or
\`coforge message read --target <target>\`; either may return nothing, because a message can
already have been read. A notice you have not acted on does not establish that there is no work.]`,
    );
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

  /** Whether the Agent's consumed cursor already covers this well-formed delivery. Reads the
   * durable cursor, so it throws for an Agent id that cursor cannot store. Lets the runtime drop a
   * stale delivery before it wakes an exited Agent for it. */
  hasConsumed(message: AgentMessageDelivery): boolean {
    return hasDeliveryScope(message) && this.#consumed(message);
  }

  /** Whether this well-formed delivery is one that never wakes the Agent (another Agent's channel
   * chatter that does not mention it), so an exited Agent need not be launched for it. */
  isSilent(message: AgentMessageDelivery): boolean {
    return hasDeliveryScope(message) && !shouldWakeForDelivery(message);
  }

  /** ACKs a delivery without notifying the Agent: the caller has established it needs no attention. */
  acknowledge(message: AgentMessageDelivery): Promise<void> {
    return this.sendAck({
      ...message,
      method: AGENT_MESSAGE_ACK_METHOD,
      requestId: message.requestId,
    });
  }

  /** Records messages the Agent was shown individually, so a later delivery of any of them is
   * treated as already consumed even when the contiguous frontier has not reached it. */
  recordSeenMessages(agentId: string, messages: readonly { target: string; id: string }[]): void {
    for (const { target, id } of messages) {
      if (!target || !id) continue;
      const byTarget = this.#seenMessageIds.get(agentId) ?? new Map<string, Set<string>>();
      const ids = byTarget.get(target) ?? new Set<string>();
      ids.delete(id);
      ids.add(id);
      if (ids.size > SEEN_MESSAGE_LIMIT) ids.delete(ids.values().next().value!);
      byTarget.set(target, ids);
      this.#seenMessageIds.set(agentId, byTarget);
    }
  }

  /** Whether the Agent has already been shown this delivery's message: at or below its target's
   * contiguous frontier, or shown individually. */
  #consumed(message: AgentMessageDelivery & { target: string }): boolean {
    return (
      this.modelSeenSequence(message.agentId, message.target) >= message.sequence ||
      this.#seenMessageIds.get(message.agentId)?.get(message.target)?.has(message.messageId) ===
        true
    );
  }

  modelSeenSequence(agentId: string, target: string): number {
    this.#hydrate(agentId);
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
    this.#hydrate(agentId);
    const byTarget = this.#modelSeen.get(agentId) ?? new Map<string, number>();
    byTarget.set(target, Math.max(byTarget.get(target) ?? 0, sequence));
    this.#modelSeen.set(agentId, byTarget);
    // Raft's `recordConsumedSeqs(agentId, { [target]: sequence })`: the Agent has consumed this
    // frontier, so it survives the process — the same cursor that decides the next hold, the
    // `seenUpToSeq` a fresh send inherits, and which target was read most recently.
    this.#notePersistedOrder(
      agentId,
      this.#consumedSeqs?.recordConsumedSeqs(agentId, { [target]: sequence }),
    );

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
    this.#hydrate(agentId);
    // Raft's `recordConsumedRead`: reviewing a target is what orders it against every other target,
    // which is the comparison the thread-target guard makes (`parentReadOrder >= thread.readOrder`).
    // With a durable cursor present the file hands out the order, so this process's orders continue
    // the ones a previous process handed out; without one this counter is the only home, as before.
    const persisted = this.#consumedSeqs?.recordConsumedRead(agentId, target);
    const order = persisted ?? (this.#readContextCounters.get(agentId) ?? 0) + 1;
    this.#readContextCounters.set(
      agentId,
      Math.max(this.#readContextCounters.get(agentId) ?? 0, order),
    );
    const byTarget = this.#readContext.get(agentId) ?? new Map<string, number>();
    byTarget.set(target, order);
    this.#readContext.set(agentId, byTarget);
  }

  /** Keeps this Agent's read-order counter above every order the durable cursor has handed out, so
   * a target reviewed before a restart can never outrank one reviewed after it. */
  #notePersistedOrder(agentId: string, order: number | undefined): void {
    if (order === undefined) return;
    const counter = this.#readContextCounters.get(agentId) ?? 0;
    if (counter < order) this.#readContextCounters.set(agentId, order);
  }

  /** The most recently read context order for `target`, or `undefined` if never recorded. */
  readOrder(agentId: string, target: string): number | undefined {
    this.#hydrate(agentId);
    return this.#readContext.get(agentId)?.get(target);
  }

  /** The most recently read thread target rooted under `parentTarget`, or `undefined` if none. */
  latestThreadReadUnderParent(
    agentId: string,
    parentTarget: string,
  ): { target: string; order: number } | undefined {
    this.#hydrate(agentId);
    const byTarget = this.#readContext.get(agentId);
    if (!byTarget) return undefined;
    const prefix = `${parentTarget}:`;
    let latest: { target: string; order: number } | undefined;
    for (const [target, order] of byTarget)
      if (target.startsWith(prefix) && (!latest || order > latest.order))
        latest = { target, order };
    return latest;
  }

  /** Folds the durable consumed cursor for one Agent into this index's own maps, once per daemon
   * life. Every value is merged with `Math.max`, so a cursor that travelled backwards — a file
   * written by an older build, or a hand-edit — can never un-review context this process already
   * consumed. The read-order counter resumes above every order in the file, exactly as Raft's
   * `normalizeState` leaves `nextReadOrder`. */
  #hydrate(agentId: string): void {
    const store = this.#consumedSeqs;
    if (!store || this.#hydrated.has(agentId)) return;
    this.#hydrated.add(agentId);
    const state = store.read(agentId);
    const modelSeen = this.#modelSeen.get(agentId) ?? new Map<string, number>();
    const readContext = this.#readContext.get(agentId) ?? new Map<string, number>();
    for (const [target, entry] of Object.entries(state.targets)) {
      const seq = entry.seq;
      if (typeof seq === "number" && seq > 0)
        modelSeen.set(target, Math.max(modelSeen.get(target) ?? 0, seq));
      const order = entry.readOrder;
      if (typeof order === "number" && order > 0)
        readContext.set(target, Math.max(readContext.get(target) ?? 0, order));
    }
    if (modelSeen.size > 0) this.#modelSeen.set(agentId, modelSeen);
    if (readContext.size > 0) this.#readContext.set(agentId, readContext);
    this.#readContextCounters.set(
      agentId,
      Math.max(this.#readContextCounters.get(agentId) ?? 0, state.nextReadOrder - 1),
    );
  }

  clearAgent(agentId: string): void {
    this.#hydrated.delete(agentId);
    this.#generations.delete(agentId);
    this.#attention.delete(agentId);
    this.#modelSeen.delete(agentId);
    this.#seenMessageIds.delete(agentId);
    this.#pendingSequences.delete(agentId);
    this.#pendingWindow.delete(agentId);
    this.#latestKnown.delete(agentId);
    this.#readContext.delete(agentId);
    this.#readContextCounters.delete(agentId);
    this.#memoryReminders.delete(agentId);
  }

  /** Forgets the pending attention of these channel targets and every thread under them: the Agent
   * can no longer read them. */
  clearTargets(agentId: string, targets: readonly string[]): void {
    const lost = (target: string) =>
      targets.some((channel) => target === channel || target.startsWith(`${channel}:`));
    const keys = new Set([
      ...(this.#attention.get(agentId)?.keys() ?? []),
      ...(this.#pendingSequences.get(agentId)?.keys() ?? []),
      ...(this.#pendingWindow.get(agentId)?.keys() ?? []),
    ]);
    for (const target of keys) if (lost(target)) this.clear(agentId, target);
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
