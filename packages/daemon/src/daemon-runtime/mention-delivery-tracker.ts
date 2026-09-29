import { getLogger } from "@logtape/logtape";
import {
  MENTION_DELIVERY_TERMINAL_CODES,
  type AgentMentionDeliveryTerminalError,
  type AgentMentionDeliveryTransition,
  type AgentMessageDelivery,
  type MentionDeliveryEnvelope,
  type MentionDeliveryStage,
  type MentionDeliveryTerminalCode,
  type MentionDeliveryTransitionOutcome,
} from "@lrm/coforge-sdk/internal";
import type { DeliveryHoldReason } from "./agent-delivery-queue";

const logger = getLogger(["coforge", "daemon", "mention-delivery"]);

/** A delivery carrying a tracked @mention envelope. */
export type TrackedMentionDelivery = AgentMessageDelivery & {
  mentionDelivery: MentionDeliveryEnvelope;
};

export function isTrackedMention(message: AgentMessageDelivery): message is TrackedMentionDelivery {
  return message.mentionDelivery !== undefined;
}

/** The launch and native session the daemon reported for an Agent's running process: what a
 * tracked mention's envelope must name to be told to it. */
export type RunningMentionIdentity = Readonly<{ launchId: string; sessionId: string }>;

/** Why an Agent cannot be told a notice right now: an explicit delivery hold, or a busy runtime
 * that only takes notices between turns. */
export type MentionDeliveryBlock = DeliveryHoldReason | "queued_until_idle";

const BLOCKED_CODES: Readonly<Record<MentionDeliveryBlock, MentionDeliveryTerminalCode>> = {
  rate_limit_backoff: MENTION_DELIVERY_TERMINAL_CODES.QUOTA_LIMITED,
  runtime_error_backoff: MENTION_DELIVERY_TERMINAL_CODES.DELIVERY_REJECTED,
  fingerprint_fence: MENTION_DELIVERY_TERMINAL_CODES.DELIVERY_REJECTED,
  queued_until_idle: MENTION_DELIVERY_TERMINAL_CODES.UNSUPPORTED_DELIVERY_PATH,
};

/** What the tracker needs from the rest of the runtime. */
export type MentionDeliveryPorts = {
  /** Reports sent over the daemon's WSS RPC. */
  transition(report: AgentMentionDeliveryTransition): Promise<void>;
  terminalError(report: AgentMentionDeliveryTerminalError): Promise<void>;
  /** ACKs the delivery with its envelope echoed. */
  acknowledge(message: TrackedMentionDelivery): Promise<void>;
  /** The launch and session last reported for the Agent's running process, if one runs. */
  running(agentId: string): RunningMentionIdentity | undefined;
  /** Whether the Agent's consumed cursor already covers the message. */
  consumed(message: TrackedMentionDelivery): boolean;
  /** Whether the Agent's current session already accepted a notice of this delivery. */
  told(message: TrackedMentionDelivery): boolean;
  /** Writes the delivery's notice to the Agent's session: `gone` when its process went away before
   * the notice was accepted. Rejects when the session refused it. */
  announce(message: TrackedMentionDelivery): Promise<"told" | "gone">;
  /** Whether the Agent is mid-turn: a notice written now lands in the turn in progress. */
  busy(agentId: string): boolean;
  blocked(agentId: string): MentionDeliveryBlock | undefined;
};

type TrackedState = "received" | "pending" | "drained";
type Tracked = {
  message: TrackedMentionDelivery;
  state: TrackedState;
  /** The session reported that the notice carrying it never reached the model; that notice's
   * redelivery settles it. */
  undelivered?: true;
};

/** Tracked mentions remembered at most, oldest forgotten first. A mention the server issues again
 * after it was forgotten is judged afresh, which only repeats a report the server already has. */
const REMEMBERED_MENTIONS = 4096;

const namesLaunch = (identity: RunningMentionIdentity, envelope: MentionDeliveryEnvelope) =>
  identity.launchId === envelope.launchId && identity.sessionId === envelope.sessionId;

/**
 * The daemon's side of tracked @mention delivery. A tracked delivery is ACKed, with its envelope
 * echoed, only once it is drained: told to the launch and session its envelope names while the
 * Agent was idle, told during a turn that has since ended, or already consumed. Otherwise the
 * daemon reports the terminal error that explains why it will not be. State lives in memory
 * only: the server issues a pending envelope again with the same delivery id, and a daemon restart
 * starts over. Nothing is reported when a process exits.
 */
export class MentionDeliveryTracker {
  readonly #tracked = new Map<string, Tracked>();
  /** Delivery ids pending per Agent: told during a turn that has not ended. */
  readonly #pending = new Map<string, Set<string>>();

  constructor(
    private readonly computerId: string,
    private readonly ports: MentionDeliveryPorts,
  ) {}

  /** Why the envelope cannot belong to this delivery on this Computer, checked on receipt before
   * the delivery is queued anywhere; undefined when it can. */
  admissionRefusal(message: TrackedMentionDelivery): MentionDeliveryTerminalCode | undefined {
    if (message.mentionDelivery.computerId !== this.computerId)
      return MENTION_DELIVERY_TERMINAL_CODES.IDENTITY_DRIFT;
    if (message.mentionDelivery.messageId !== message.messageId)
      return MENTION_DELIVERY_TERMINAL_CODES.INSTRUMENT_FAILED;
    return undefined;
  }

  /**
   * Tells a tracked mention to the Agent's running session and settles what follows. A consumed
   * message is drained whatever launch the envelope names; otherwise the envelope must name the
   * running launch and session. A repeat of a drained mention is ACKed again, and of one still
   * being told for the same launch is reported coalesced; one issued for a newer launch is told
   * afresh. Told while the Agent is idle, it is drained; told during a turn, it stays pending until
   * that turn ends. Rejects only when the session refused the notice (after reporting it).
   */
  async deliver(message: TrackedMentionDelivery): Promise<void> {
    if (this.ports.consumed(message)) return this.#drain(message);
    const envelope = message.mentionDelivery;
    const running = this.ports.running(message.agentId);
    if (!running) return this.refuse(message, MENTION_DELIVERY_TERMINAL_CODES.IDENTITY_UNKNOWN);
    if (!namesLaunch(running, envelope))
      return this.refuse(message, MENTION_DELIVERY_TERMINAL_CODES.IDENTITY_DRIFT);
    const existing = this.#tracked.get(message.deliveryId);
    if (existing) {
      if (
        existing.message.agentId !== message.agentId ||
        existing.message.messageId !== message.messageId
      )
        return this.refuse(message, MENTION_DELIVERY_TERMINAL_CODES.INSTRUMENT_FAILED);
      if (existing.state === "drained") {
        existing.message = message;
        return this.#acknowledge(message);
      }
      if (namesLaunch(existing.message.mentionDelivery, envelope)) {
        existing.message = message;
        this.#transition(message, "daemon_pending", "coalesced");
        return;
      }
    }
    this.#set(message, "received");
    this.#transition(message, "daemon_received", "accepted");
    if (this.ports.told(message)) return this.#told(message);
    const blocked = this.ports.blocked(message.agentId);
    if (blocked) return this.refuse(message, BLOCKED_CODES[blocked]);
    // Read before the notice: writing it marks the Agent busy.
    const busy = this.ports.busy(message.agentId);
    let outcome: "told" | "gone";
    try {
      outcome = await this.ports.announce(message);
    } catch (error) {
      await this.refuse(message, MENTION_DELIVERY_TERMINAL_CODES.DELIVERY_REJECTED);
      throw error;
    }
    if (!this.#receiving(message)) return;
    if (outcome === "gone") {
      const now = this.ports.running(message.agentId);
      return this.refuse(
        message,
        now && !namesLaunch(now, envelope)
          ? MENTION_DELIVERY_TERMINAL_CODES.IDENTITY_DRIFT
          : MENTION_DELIVERY_TERMINAL_CODES.DELIVERY_REJECTED,
      );
    }
    return busy ? this.#markPending(message) : this.#drain(message);
  }

  /**
   * Settles a delivery the daemon is dropping without telling any session. Returns false for an
   * untracked delivery, which the caller settles its own way. A tracked one is drained when the
   * Agent already consumed it, and otherwise refused with `code`.
   */
  drop(message: AgentMessageDelivery, code: MentionDeliveryTerminalCode): boolean {
    if (!isTrackedMention(message)) return false;
    void (this.ports.consumed(message) ? this.#drain(message) : this.refuse(message, code));
    return true;
  }

  /**
   * The Agent's turn ended: each mention still pending for it ends here, or it would stay pending
   * with nothing left to tell the Agent and every re-issue would only be coalesced. One the current
   * session was told, or the Agent consumed, is drained; one whose notice the session reported lost
   * waits for that notice's redelivery; any other (told to a process that has since exited) is
   * rejected.
   */
  async settleTurnEnd(agentId: string): Promise<void> {
    const pending = this.#pending.get(agentId);
    if (!pending) return;
    for (const deliveryId of [...pending]) {
      const tracked = this.#tracked.get(deliveryId);
      if (!tracked || tracked.undelivered) continue;
      const { message } = tracked;
      if (this.ports.told(message) || this.ports.consumed(message)) await this.#drain(message);
      else await this.refuse(message, MENTION_DELIVERY_TERMINAL_CODES.DELIVERY_REJECTED);
    }
  }

  /** Records that the session never showed the model the notice carrying these deliveries: they
   * stay unacknowledged until that notice's redelivery settles them (`settleRedelivery`). */
  markUndelivered(agentId: string, deliveryIds: readonly string[]): void {
    for (const deliveryId of deliveryIds) {
      const tracked = this.#tracked.get(deliveryId);
      if (tracked?.message.agentId === agentId && tracked.state !== "drained")
        tracked.undelivered = true;
    }
  }

  /** The notice that carried these deliveries was delivered again after its turn ended: drained
   * once the session accepted it, rejected when it did not. */
  async settleRedelivery(
    agentId: string,
    deliveryIds: readonly string[],
    accepted: boolean,
  ): Promise<void> {
    for (const deliveryId of deliveryIds) {
      const tracked = this.#tracked.get(deliveryId);
      if (tracked?.message.agentId !== agentId || !tracked.undelivered) continue;
      if (accepted) await this.#drain(tracked.message);
      else await this.refuse(tracked.message, MENTION_DELIVERY_TERMINAL_CODES.DELIVERY_REJECTED);
    }
  }

  /** Reports that the daemon will not tell a mention, and forgets it. */
  async refuse(message: TrackedMentionDelivery, code: MentionDeliveryTerminalCode): Promise<void> {
    this.#forget(message.deliveryId);
    logger.info("Tracked mention delivery refused", {
      event: "agent.mention_delivery.terminal_error",
      agent_id: message.agentId,
      delivery_id: message.deliveryId,
      code,
    });
    await this.#send("terminal_error", message, () =>
      this.ports.terminalError({ ...this.#scope(message), code }),
    );
  }

  /** Already told in the current session: pending while that turn runs, drained once idle. */
  #told(message: TrackedMentionDelivery): Promise<void> {
    return this.ports.busy(message.agentId) ? this.#markPending(message) : this.#drain(message);
  }

  /** Whether the mention is still between acceptance and its outcome: not settled meanwhile. */
  #receiving(message: TrackedMentionDelivery): boolean {
    return this.#tracked.get(message.deliveryId)?.state === "received";
  }

  async #markPending(message: TrackedMentionDelivery): Promise<void> {
    this.#set(message, "pending");
    this.#transition(message, "daemon_pending", "accepted");
  }

  async #drain(message: TrackedMentionDelivery): Promise<void> {
    if (this.#tracked.get(message.deliveryId)?.state !== "drained") {
      this.#set(message, "drained");
      this.#transition(message, "daemon_drained", "accepted");
    }
    await this.#acknowledge(message);
  }

  #set(message: TrackedMentionDelivery, state: TrackedState): void {
    const { deliveryId, agentId } = message;
    const previous = this.#tracked.get(deliveryId);
    if (!previous && this.#tracked.size >= REMEMBERED_MENTIONS)
      this.#forget(this.#tracked.keys().next().value!);
    this.#tracked.delete(deliveryId);
    this.#tracked.set(deliveryId, {
      message,
      state,
      ...(previous?.undelivered && state !== "drained" ? { undelivered: true } : {}),
    });
    const pending = this.#pending.get(agentId);
    if (state === "pending") {
      if (pending) pending.add(deliveryId);
      else this.#pending.set(agentId, new Set([deliveryId]));
    } else if (pending?.delete(deliveryId) && pending.size === 0) this.#pending.delete(agentId);
  }

  #forget(deliveryId: string): void {
    const tracked = this.#tracked.get(deliveryId);
    if (!tracked) return;
    this.#tracked.delete(deliveryId);
    const pending = this.#pending.get(tracked.message.agentId);
    pending?.delete(deliveryId);
    if (pending?.size === 0) this.#pending.delete(tracked.message.agentId);
  }

  /** Diagnostic only: sent without waiting, so it never delays telling the Agent. */
  #transition(
    message: TrackedMentionDelivery,
    stage: MentionDeliveryStage,
    outcome: MentionDeliveryTransitionOutcome,
  ): void {
    void this.#send("transition", message, () =>
      this.ports.transition({ ...this.#scope(message), stage, outcome }),
    );
  }

  #acknowledge(message: TrackedMentionDelivery): Promise<void> {
    return this.#send("ack", message, () => this.ports.acknowledge(message));
  }

  #scope(message: TrackedMentionDelivery) {
    return {
      protocolMajor: message.protocolMajor,
      requestId: crypto.randomUUID(),
      workspaceId: message.workspaceId,
      agentId: message.agentId,
      deliveryId: message.deliveryId,
      mentionDelivery: message.mentionDelivery,
    };
  }

  /** A report that fails is logged, never thrown: the server still holds the mention pending and
   * issues it again. */
  async #send(
    kind: "transition" | "terminal_error" | "ack",
    message: TrackedMentionDelivery,
    send: () => Promise<void>,
  ): Promise<void> {
    try {
      await send();
    } catch (error) {
      logger.warn("Tracked mention delivery report was not sent", {
        event: "agent.mention_delivery.report_failed",
        report: kind,
        agent_id: message.agentId,
        delivery_id: message.deliveryId,
        error_code: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
}
