import type {
  AgentMessageDelivery,
  AgentMessageDeliveryAck,
  AgentRecoveryMessage,
  MessageSenderKind,
} from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import {
  AGENT_MESSAGE_ACK_METHOD,
  HELD_CONTEXT_LIMIT,
  isChannelMessageTarget,
  isValidMessageSender,
  mergeSeenExactSeqs,
  renderMessageSender,
  threadRootTarget,
} from "@lrm/coforge-sdk/internal";
import type { AgentHistoryConsumptionScope } from "@lrm/coforge-sdk/agent";
import type { AgentProcessManager } from "#src/agent-runtime/agent-process-manager";
import { isTrackedMention } from "./mention-delivery-tracker";
import type {
  AgentConsumedSeqEntry,
  AgentConsumedSeqPort,
} from "#src/persistence/agent-consumed-seq-store";

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
 * freshness hold to show: exactly `HELD_CONTEXT_LIMIT` (in the SDK's `freshness-decision.ts`),
 * because the hold shows the newest that many and no more — and anything older is consumed by the
 * same frontier anyway. No invented slack. */
const PENDING_WINDOW_LIMIT = HELD_CONTEXT_LIMIT;

/** Footer shared by live and recovery inbox notices. Names the targeted drain; does not claim
 * unread state, because a notice can race a check/read that already advanced the cursor. */
const INBOX_DRAIN_HINT =
  "Drain each listed target with `coforge message check --target <target>`, or inspect with `coforge message read --target <target>`. Either may return nothing, because a message can already have been read.";

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
  /** `exactSeqs`: the sequences above each target's contiguous frontier that the Agent was shown
   * one by one (a `check`, an anchored `read`, a read the server did not call contiguous), kept
   * ascending so a lookup is a binary search and an addition a linear merge. Durable with the
   * frontier, bounded by `SEEN_EXACT_SEQS_LIMIT` per target, and pruned as the frontier reaches
   * them. */
  readonly #exactSeen = new Map<string, Map<string, readonly number[]>>();
  /** `aliases`, with chains compressed: every spelling maps straight to the canonical target its
   * consumed state is kept under, so a lookup is one `get`. */
  readonly #aliases = new Map<string, Map<string, string>>();
  /** The targets with attention in each conversation, learned from their deliveries and pruned with
   * the attention, so a history read's consumption scope settles a conversation's targets however
   * each is spelled. `#attentionConversation` is the way back, for the pruning. */
  readonly #conversationTargets = new Map<string, Map<string, Set<string>>>();
  readonly #attentionConversation = new Map<string, Map<string, string>>();
  readonly #pendingSequences = new Map<string, Map<string, Set<number>>>();
  /** The newest unreviewed deliveries per Agent and target, with the moment the daemon learned
   * about each. Kept so a locally decided freshness hold can show the Agent the same bounded
   * window the server's hold would have shown — and so the hold can count that window as
   * reviewed, which is what lets a resend through instead of holding it again. Bounded by
   * `PENDING_WINDOW_LIMIT`; pruned as the boundary advances and dropped with the Agent. */
  readonly #pendingWindow = new Map<string, Map<string, PendingWindowEntry[]>>();
  readonly #readContext = new Map<string, Map<string, number>>();
  /** The newest message a review of each target showed: a `read` other than `--around`, or the
   * context a presented (not withheld) hold showed, which reviews the target as well as moving its
   * frontier. Unlike `#modelSeen`, a `check`, an anchored read and a sent send's advanced boundary
   * never move it: it answers "has a review shown the Agent anything here", which is what makes a
   * thread count as reply context. Persisted apart from the frontier as `reviewedSeq`. */
  readonly #reviewedSequence = new Map<string, Map<string, number>>();
  readonly #readContextCounters = new Map<string, number>();
  /** `consumed-seqs.json`: the durable copy of `#modelSeen` (the `seq` frontier), `#readContext`
   * (the `readOrder` each target was last reviewed at), `#reviewedSequence` (`reviewedSeq`),
   * `#exactSeen` (`exactSeqs`) and `#aliases`. Once an Agent is hydrated these maps are the
   * source of truth, and each operation writes one snapshot of them. */
  readonly #consumedSeqs?: AgentConsumedSeqPort;
  /** Agents whose durable cursor has already been folded into the maps above. The file is read
   * once per Agent per daemon life rather than on every lookup: the same answer, minus the
   * syscall in a message loop, and `clearAgent` drops the marker so a re-registered Agent reads
   * it again. */
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
      /** The Agent's durable consumed cursor (`consumed-seqs.json`). Without it the index is
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
          // Held for a later notice: the daemon has it, so it is acknowledged now.
          this.acknowledgeCustody(message);
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
    if (this.hold.shouldHold(message.agentId)) {
      this.hold.enqueue(message.agentId, message);
      // Held for a later notice: the daemon has it, so it is acknowledged now.
      this.acknowledgeCustody(message);
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
   * Tells the Agent's session about one delivery without acknowledging it and without holding it:
   * for a tracked mention, whose acknowledgement `MentionDeliveryTracker` owns. A delivery an
   * earlier notice already announced (or is announcing) is not announced again. Resolves `told`
   * once a notice of it was accepted, `gone` when the Agent's process went away first; rejects
   * when the session refused the notice.
   */
  async announce(message: AgentMessageDelivery): Promise<"told" | "gone"> {
    if (message.workspaceId !== this.#workspaceId)
      throw new Error("agent message targets another Workspace");
    if (!hasDeliveryScope(message)) throw new Error("invalid agent message scope");
    const generation = this.#generation(message.agentId);
    if (!generation.seenDeliveryIds.has(message.deliveryId)) {
      this.#remember(generation, message.deliveryId);
      await this.#notify(message, this.#recordAttention(message));
    } else if (!generation.notified.has(message.deliveryId))
      await (generation.notificationAttempts.get(message.deliveryId) ?? this.#notify(message));
    return this.#generations.get(message.agentId) === generation ? "told" : "gone";
  }

  /** Whether the Agent's current session accepted a notice of this delivery. */
  wasNotified(message: AgentMessageDelivery): boolean {
    return this.#generations.get(message.agentId)?.notified.has(message.deliveryId) === true;
  }

  /** Records one delivery the Agent has not been shown yet: its target's attention, pending
   * sequences, and the window a local hold presents. */
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
      flags: [
        isChannelMessageTarget(target) ? "channel" : target.includes(":") ? "thread" : "dm",
        // Reached the Agent from outside the channel: it can read the message, not reply there.
        ...(message.nonMemberMention || previous?.flags.includes("non_member_mention")
          ? ["non_member_mention"]
          : []),
      ],
    };
    byTarget.set(target, current);
    this.#attention.set(message.agentId, byTarget);
    this.#recordConversation(message.agentId, target, message.conversationId);
    this.#recordPendingWindow(message.agentId, target, message);
    return current;
  }

  /**
   * Delivers every notice `AgentDeliveryQueue` held for `agentId`, oldest first, as
   * one call to `AgentSession.notify` once the Agent is idle — the daemon core is the only
   * caller, right after `AgentDeliveryQueue.idle`/`release` hands back what it drained. A delivery
   * held by `receive` already passed its checks and has its attention recorded. One the runtime
   * queued before the Agent's process existed (a wake cooldown, a batched wake) gets `receive`'s
   * treatment here: an already-consumed one is not announced and a malformed one is skipped.
   * Every delivery was acknowledged when the daemon took it into the queue, so this only
   * presents them.
   */
  async flush(agentId: string, held: readonly AgentMessageDelivery[]): Promise<void> {
    if (!held.length) return;
    const generation = this.#generation(agentId);
    const settled: AgentMessageDelivery[] = [];
    const announced: AgentMessageDelivery[] = [];
    for (const message of held) {
      if (!hasDeliveryScope(message)) continue;
      settled.push(message);
      if (generation.seenDeliveryIds.has(message.deliveryId)) {
        announced.push(message);
        continue;
      }
      this.#remember(generation, message.deliveryId);
      if (this.#consumed(message)) continue;
      this.#recordAttention(message);
      announced.push(message);
    }
    // One notice for the whole coalesced batch, carrying the batch itself: the queue is per Agent,
    // so a batch legitimately spans channels, DMs and threads, and each target needs its own line.
    if (announced.length) {
      await this.#notify(announced[announced.length - 1]!, undefined, announced);
      if (this.#generations.get(agentId) !== generation) return;
    }
    // Every held delivery was acknowledged when the daemon took it; a redelivery of one after this
    // notice is acknowledged again without another notice.
    for (const message of settled) generation.notified.add(message.deliveryId);
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
          ...(message.nonMemberMention || previous?.flags.includes("non_member_mention")
            ? ["non_member_mention"]
            : []),
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
    // and `check` is what advances it (and records what it showed as exact sequences).
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
${INBOX_DRAIN_HINT}]`,
    );
    // Same synchronous-busy rule as `#notify` — this is also a `session.notify` call.
    this.hold.busy(agentId);
    await session.notify(notice);
    if (this.#generations.get(agentId) !== generation) return;
    this.#attention.set(agentId, byTarget);
    for (const message of recoveredMessages) {
      this.#recordConversation(agentId, message.target, message.conversationId);
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
${INBOX_DRAIN_HINT}]`,
    );
    // The session names these back if the notice never reaches the model (`notice-undelivered`).
    const trackedIds = announced.filter(isTrackedMention).map((delivery) => delivery.deliveryId);
    const notification = Promise.resolve()
      .then(() =>
        trackedIds.length
          ? session.notify!(notice, { deliveryIds: trackedIds })
          : session.notify!(notice),
      )
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

  /**
   * ACKs a delivery the daemon has just taken into its own keeping (held for a later notice or
   * launch, or dropped), without waiting: a failed ACK only means the server replays it on the
   * next `ready`, and a daemon restart recovers unread messages from the cloud read boundary.
   */
  acknowledgeCustody(message: AgentMessageDelivery): void {
    void this.acknowledge(message).catch((error: unknown) => {
      logger.warn("Agent delivery could not be acknowledged on taking it", {
        event: "agent.message.custody_ack_failed",
        agent_id: message.agentId,
        delivery_id: message.deliveryId,
        error_code: error instanceof Error ? error.name : "UnknownError",
      });
    });
  }

  /** ACKs a delivery without notifying the Agent: the caller has established it needs no attention. */
  acknowledge(message: AgentMessageDelivery): Promise<void> {
    return this.sendAck({
      ...message,
      method: AGENT_MESSAGE_ACK_METHOD,
      requestId: message.requestId,
    });
  }

  /**
   * Records the messages the Agent was shown one by one, per target, above its contiguous frontier
   * (what a `check` does): a later delivery of any of them is already consumed, a send reports
   * them as `seenExactSeqs`, and their pending attention is settled. The frontier does not move.
   * At most one write, for every target.
   */
  recordExactSeen(agentId: string, shown: ReadonlyMap<string, readonly number[]>): void {
    this.#hydrate(agentId);
    let changed = false;
    for (const [target, sequences] of shown) {
      if (!target || !this.#addExact(agentId, target, sequences)) continue;
      changed = true;
      this.#settleSeen(agentId, target);
    }
    if (changed) this.#persist(agentId);
  }

  /**
   * What one history read showed the Agent (the `message read` bookkeeping), in at most one
   * write: `spelling` becomes an alias of `target`; the frontier moves to `through` (0 for none);
   * the `shown` sequences (ascending) above it become exact; a `review` orders the target; and a
   * consumption scope settles, in every other target of its conversation, exactly the messages
   * the read returned.
   */
  recordHistoryRead(
    agentId: string,
    read: {
      spelling: string;
      target: string;
      shown: readonly number[];
      through: number;
      review?: { sequence: number };
      scope?: Pick<AgentHistoryConsumptionScope, "conversationId" | "channelType" | "target">;
    },
  ): void {
    this.#hydrate(agentId);
    const { target } = read;
    let changed = this.#setAlias(agentId, read.spelling, target);
    if (read.through > 0) changed = this.#advanceFrontier(agentId, target, read.through) || changed;
    changed = this.#addExact(agentId, target, read.shown) || changed;
    this.#settleSeen(agentId, target);
    if (read.review) {
      this.#takeReadOrder(agentId, target, read.review.sequence);
      changed = true;
    }
    if (read.scope) this.#settleScope(agentId, read.scope, read.shown, target);
    if (changed) this.#persist(agentId);
  }

  /**
   * Context a send presented or a sent send's advanced boundary (the consume effect of a held
   * response and of a forwarded one), in one write: the frontier moves to `through`, and a
   * presented context (`review`) also reviews the target.
   */
  recordSendContext(
    agentId: string,
    target: string,
    through: number,
    review?: { sequence: number },
  ): void {
    if (!Number.isInteger(through) || through < 1) return;
    this.#hydrate(agentId);
    const changed = this.#advanceFrontier(agentId, target, through);
    if (review) this.#takeReadOrder(agentId, target, review.sequence);
    if (changed || review) this.#persist(agentId);
  }

  /** The exact sequences a send reports for `target` (`seenExactSeqs`): those above its
   * frontier, ascending, at most `SEEN_EXACT_SEQS_LIMIT`. Returned as held, never copied. */
  seenExactSequences(agentId: string, target: string): readonly number[] {
    this.#hydrate(agentId);
    return this.#exactSeen.get(agentId)?.get(target) ?? NO_SEQUENCES;
  }

  /** Whether the Agent was shown anything of `target` one by one above its frontier. */
  hasExactSeen(agentId: string, target: string): boolean {
    this.#hydrate(agentId);
    return (this.#exactSeen.get(agentId)?.get(target)?.length ?? 0) > 0;
  }

  /** The spelling `target`'s consumed state is kept under. */
  resolveTarget(agentId: string, target: string): string {
    this.#hydrate(agentId);
    return this.#aliases.get(agentId)?.get(target) ?? target;
  }

  /** `spelling` shares the consumed state kept under `canonical`. */
  recordTargetAlias(agentId: string, spelling: string, canonical: string): void {
    this.#hydrate(agentId);
    if (this.#setAlias(agentId, spelling, canonical)) this.#persist(agentId);
  }

  /** Whether the Agent has already been shown message `sequence` of the canonical `target`: at or
   * below its contiguous frontier, or shown one by one. */
  hasSeen(agentId: string, target: string, sequence: number): boolean {
    return (
      this.modelSeenSequence(agentId, target) >= sequence ||
      containsSorted(this.#exactSeen.get(agentId)?.get(target), sequence)
    );
  }

  /** A delivery's target is the server's canonical spelling, so it needs no alias lookup. */
  #consumed(message: AgentMessageDelivery & { target: string }): boolean {
    return this.hasSeen(message.agentId, message.target, message.sequence);
  }

  /** Adds `sequences` above the frontier to `target`'s exact set; whether anything was added. */
  #addExact(agentId: string, target: string, sequences: readonly number[]): boolean {
    if (sequences.length === 0) return false;
    const byTarget = this.#exactSeen.get(agentId) ?? new Map<string, readonly number[]>();
    const existing = byTarget.get(target) ?? NO_SEQUENCES;
    const incoming = isAscending(sequences) ? sequences : [...sequences].sort(byNumber);
    const merged = mergeSeenExactSeqs(
      this.#modelSeen.get(agentId)?.get(target) ?? 0,
      existing,
      incoming,
    );
    if (merged.length === existing.length && merged.every((value, i) => value === existing[i]))
      return false;
    byTarget.set(target, merged);
    this.#exactSeen.set(agentId, byTarget);
    return true;
  }

  /** Moves `target`'s frontier up to `sequence` (never lower), drops the exact sequences it now
   * covers, and settles the pending attention at or below it. Whether the frontier moved. */
  #advanceFrontier(agentId: string, target: string, sequence: number): boolean {
    const byTarget = this.#modelSeen.get(agentId) ?? new Map<string, number>();
    const prior = byTarget.get(target) ?? 0;
    if (sequence <= prior) return false;
    const frontier = sequence;
    byTarget.set(target, frontier);
    this.#modelSeen.set(agentId, byTarget);
    const exactByTarget = this.#exactSeen.get(agentId);
    const exact = exactByTarget?.get(target);
    if (exact?.length) {
      const kept = exact.slice(firstAbove(exact, frontier));
      if (kept.length === 0) exactByTarget!.delete(target);
      else if (kept.length !== exact.length) exactByTarget!.set(target, kept);
    }
    this.#settlePending(agentId, target, (pending) => pending <= frontier);
    return true;
  }

  /** Settles `target`'s pending attention for everything the Agent has seen of it. */
  #settleSeen(agentId: string, target: string): void {
    const frontier = this.#modelSeen.get(agentId)?.get(target) ?? 0;
    const exact = this.#exactSeen.get(agentId)?.get(target);
    this.#settlePending(
      agentId,
      target,
      (sequence) => sequence <= frontier || containsSorted(exact, sequence),
    );
  }

  /**
   * Settles, in every target of the conversation (and thread) a consumption scope names other than
   * `settled` (which the caller settled already), exactly the messages the history read returned:
   * a pending notice is suppressed only when the history response carried that message, however
   * its target is spelled. Targets are matched by conversation, and a thread by its root whatever
   * its case or length. `shown` is ascending.
   */
  #settleScope(
    agentId: string,
    scope: Pick<AgentHistoryConsumptionScope, "conversationId" | "channelType" | "target">,
    shown: readonly number[],
    settled: string,
  ): void {
    if (shown.length === 0) return;
    const targets = this.#conversationTargets.get(agentId)?.get(scope.conversationId);
    if (!targets) return;
    const scopeRoot = threadRootTarget(scope.target);
    if (scope.channelType === "thread" && scopeRoot === undefined) return;
    for (const target of targets) {
      if (target === settled) continue;
      const root = threadRootTarget(target);
      if (scope.channelType === "dm" ? root !== undefined : !sameThreadRoot(root, scopeRoot!))
        continue;
      this.#settlePending(agentId, target, (sequence) => containsSorted(shown, sequence));
    }
  }

  /** Drops the pending sequences `settled` covers from one target's attention and window, and the
   * attention itself once nothing is left pending. */
  #settlePending(agentId: string, target: string, settled: (sequence: number) => boolean): void {
    const pending = this.#pendingSequences.get(agentId)?.get(target);
    if (pending) for (const sequence of pending) if (settled(sequence)) pending.delete(sequence);
    const byTarget = this.#pendingWindow.get(agentId);
    const entries = byTarget?.get(target);
    if (byTarget && entries) {
      const kept = entries.filter((entry) => !settled(entry.delivery.sequence));
      if (kept.length === 0) byTarget.delete(target);
      else if (kept.length !== entries.length) byTarget.set(target, kept);
    }
    const attention = this.#attention.get(agentId)?.get(target);
    if (!attention) return;
    if (!pending || pending.size === 0) {
      this.clear(agentId, target);
      return;
    }
    if (pending.size === attention.pendingCount) return;
    let first = Infinity;
    for (const sequence of pending) if (sequence < first) first = sequence;
    this.#attention.get(agentId)?.set(target, {
      ...attention,
      pendingCount: pending.size,
      firstPendingSequence: first,
    });
  }

  #recordConversation(agentId: string, target: string, conversationId: string): void {
    const byTarget = this.#attentionConversation.get(agentId) ?? new Map<string, string>();
    this.#attentionConversation.set(agentId, byTarget);
    if (byTarget.get(target) === conversationId) return;
    byTarget.set(target, conversationId);
    const byConversation = this.#conversationTargets.get(agentId) ?? new Map<string, Set<string>>();
    this.#conversationTargets.set(agentId, byConversation);
    const targets = byConversation.get(conversationId) ?? new Set<string>();
    targets.add(target);
    byConversation.set(conversationId, targets);
  }

  #forgetConversation(agentId: string, target: string): void {
    const byTarget = this.#attentionConversation.get(agentId);
    const conversationId = byTarget?.get(target);
    if (conversationId === undefined) return;
    byTarget!.delete(target);
    const byConversation = this.#conversationTargets.get(agentId);
    const targets = byConversation?.get(conversationId);
    targets?.delete(target);
    if (targets?.size === 0) byConversation!.delete(conversationId);
  }

  /** Maps `spelling` to `canonical`'s canonical target and repoints any spelling that named
   * `spelling`, keeping every chain one step long. Whether anything changed. */
  #setAlias(agentId: string, spelling: string, canonical: string): boolean {
    if (!spelling || !canonical || spelling === canonical) return false;
    const aliases = this.#aliases.get(agentId) ?? new Map<string, string>();
    let target = aliases.get(canonical) ?? canonical;
    // `canonical` was itself a spelling of `spelling`: the newer mapping wins.
    if (target === spelling) {
      aliases.delete(canonical);
      target = canonical;
    }
    if (aliases.get(spelling) === target) return false;
    aliases.set(spelling, target);
    for (const [other, named] of aliases) if (named === spelling) aliases.set(other, target);
    this.#aliases.set(agentId, aliases);
    return true;
  }

  #takeReadOrder(agentId: string, target: string, sequence: number): void {
    if (Number.isInteger(sequence) && sequence > 0) {
      const reviewed = this.#reviewedSequence.get(agentId) ?? new Map<string, number>();
      reviewed.set(target, Math.max(reviewed.get(target) ?? 0, sequence));
      this.#reviewedSequence.set(agentId, reviewed);
    }
    // Reviewing a target is what orders it against every other target, which is the comparison
    // the thread-mismatch guard makes. The counter resumes above every order the durable cursor
    // held (see `#hydrate`).
    const order = (this.#readContextCounters.get(agentId) ?? 0) + 1;
    this.#readContextCounters.set(agentId, order);
    const byTarget = this.#readContext.get(agentId) ?? new Map<string, number>();
    byTarget.set(target, order);
    this.#readContext.set(agentId, byTarget);
  }

  /** Writes one snapshot of the Agent's durable consumed state. */
  #persist(agentId: string): void {
    const store = this.#consumedSeqs;
    if (!store) return;
    const targets: Record<string, AgentConsumedSeqEntry> = {};
    const entry = (target: string) => (targets[target] ??= {}) as MutableEntry;
    for (const [target, seq] of this.#modelSeen.get(agentId) ?? []) entry(target).seq = seq;
    const reviewed = this.#reviewedSequence.get(agentId);
    for (const [target, readOrder] of this.#readContext.get(agentId) ?? []) {
      const record = entry(target);
      record.readOrder = readOrder;
      const reviewedSeq = reviewed?.get(target);
      if (reviewedSeq !== undefined) record.reviewedSeq = reviewedSeq;
    }
    for (const [target, exactSeqs] of this.#exactSeen.get(agentId) ?? [])
      if (exactSeqs.length > 0) entry(target).exactSeqs = exactSeqs;
    store.write(agentId, {
      targets,
      aliases: Object.fromEntries(this.#aliases.get(agentId) ?? []),
      nextReadOrder: (this.#readContextCounters.get(agentId) ?? 0) + 1,
    });
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

  /** The newest message the Agent has not been shown for this exact target, or 0: what a locally
   * held send presents as its `seenUpToSeq` (the held boundary is the unconsumed maximum). */
  pendingMaxSequence(agentId: string, target: string): number {
    let max = 0;
    for (const sequence of this.#pendingSequences.get(agentId)?.get(target) ?? [])
      if (sequence > max) max = sequence;
    return max;
  }

  /** The newest unreviewed deliveries for `target`, oldest first, at most `limit` of them: the
   * window a locally decided hold presents. */
  pendingWindow(agentId: string, target: string, limit: number): readonly PendingWindowEntry[] {
    const entries = this.#pendingWindow.get(agentId)?.get(target) ?? [];
    return entries.slice(-limit);
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

  /** Moves `target`'s consumed frontier to `sequence` (never lower), in one write: the cursor that
   * decides the next hold and the `seenUpToSeq` a fresh send inherits. Consuming is not reviewing:
   * it orders nothing. */
  recordModelSeen(agentId: string, target: string, sequence: number): void {
    if (!Number.isInteger(sequence) || sequence < 1) return;
    this.#hydrate(agentId);
    if (this.#advanceFrontier(agentId, target, sequence)) this.#persist(agentId);
  }

  /**
   * Records that the Agent just reviewed `target` (a `read` other than `--around`, or the context a
   * held `send` presented), under a per-Agent monotonically increasing read order, and the newest
   * `sequence` that review showed, if any. Used only by the thread-mismatch send guard, to compare
   * how recently a thread was read against how recently its parent target was read.
   */
  recordReadContext(agentId: string, target: string, sequence = 0): void {
    this.#hydrate(agentId);
    this.#takeReadOrder(agentId, target, sequence);
    this.#persist(agentId);
  }

  /** The most recently read context order for `target`, or `undefined` if never recorded. */
  readOrder(agentId: string, target: string): number | undefined {
    this.#hydrate(agentId);
    return this.#readContext.get(agentId)?.get(target);
  }

  /** The most recently read thread target rooted under `parentTarget` whose reads have shown the
   * Agent at least one message, or `undefined` if none. A thread read that returned nothing gave
   * the Agent no thread context to reply to. */
  latestThreadReadUnderParent(
    agentId: string,
    parentTarget: string,
  ): { target: string; order: number } | undefined {
    this.#hydrate(agentId);
    const byTarget = this.#readContext.get(agentId);
    if (!byTarget) return undefined;
    const prefix = `${parentTarget}:`;
    let latest: { target: string; order: number } | undefined;
    const reviewed = this.#reviewedSequence.get(agentId);
    for (const [target, order] of byTarget)
      if (
        target.startsWith(prefix) &&
        (reviewed?.get(target) ?? 0) > 0 &&
        (!latest || order > latest.order)
      )
        latest = { target, order };
    return latest;
  }

  /** Loads the durable consumed cursor for one Agent into this index's own maps, once per daemon
   * life, before anything else touches that Agent's cursor; from then on these maps are the source
   * of truth and each operation writes a snapshot of them. The store has already normalized the
   * file (it is input nobody in this process wrote). The read-order counter resumes above every
   * order in the file. */
  #hydrate(agentId: string): void {
    const store = this.#consumedSeqs;
    if (!store || this.#hydrated.has(agentId)) return;
    this.#hydrated.add(agentId);
    const state = store.read(agentId);
    const modelSeen = new Map<string, number>();
    const readContext = new Map<string, number>();
    const reviewedSequence = new Map<string, number>();
    const exactSeen = new Map<string, readonly number[]>();
    for (const [target, entry] of Object.entries(state.targets)) {
      if (entry.seq !== undefined) modelSeen.set(target, entry.seq);
      if (entry.readOrder !== undefined) readContext.set(target, entry.readOrder);
      if (entry.reviewedSeq !== undefined) reviewedSequence.set(target, entry.reviewedSeq);
      if (entry.exactSeqs?.length) exactSeen.set(target, entry.exactSeqs);
    }
    this.#modelSeen.set(agentId, modelSeen);
    this.#readContext.set(agentId, readContext);
    this.#reviewedSequence.set(agentId, reviewedSequence);
    this.#exactSeen.set(agentId, exactSeen);
    this.#aliases.set(agentId, new Map(Object.entries(state.aliases)));
    this.#readContextCounters.set(agentId, state.nextReadOrder - 1);
  }

  clearAgent(agentId: string): void {
    this.#hydrated.delete(agentId);
    this.#generations.delete(agentId);
    this.#attention.delete(agentId);
    this.#modelSeen.delete(agentId);
    this.#reviewedSequence.delete(agentId);
    this.#exactSeen.delete(agentId);
    this.#aliases.delete(agentId);
    this.#conversationTargets.delete(agentId);
    this.#attentionConversation.delete(agentId);
    this.#pendingSequences.delete(agentId);
    this.#pendingWindow.delete(agentId);
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
    this.#forgetConversation(agentId, target);
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

const NO_SEQUENCES: readonly number[] = [];

type MutableEntry = { -readonly [K in keyof AgentConsumedSeqEntry]: AgentConsumedSeqEntry[K] };

const byNumber = (left: number, right: number) => left - right;

function isAscending(values: readonly number[]): boolean {
  for (let i = 1; i < values.length; i++) if (values[i]! < values[i - 1]!) return false;
  return true;
}

/** The index of the first value above `bound` in an ascending list. */
function firstAbove(values: readonly number[], bound: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]! <= bound) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Whether two thread roots name the same message: compared without case, and a short (8-hex)
 * root names the full root it begins. */
function sameThreadRoot(left: string | undefined, right: string): boolean {
  if (left === undefined) return false;
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  return a === b || (a.length < b.length ? b.startsWith(a) : a.startsWith(b));
}

/** Whether an ascending list holds `value`. */
function containsSorted(values: readonly number[] | undefined, value: number): boolean {
  if (!values?.length) return false;
  const index = firstAbove(values, value - 1);
  return values[index] === value;
}
