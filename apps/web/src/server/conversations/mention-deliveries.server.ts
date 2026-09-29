/**
 * Tracked @mention delivery on the cloud side. Every delivery that personally mentions its Agent
 * is tracked on its delivery row. When the Agent has a running launch and session, the push
 * carries an envelope naming them, and the daemon answers it with an ACK echoing the envelope
 * (delivered) or a terminal error (lost with a reason category, or unknown). An Agent that is not
 * running is woken as before, without an envelope, and its mention stays pending; one nothing may
 * wake is not launched. Delivered and lost are final, except that a daemon's echoed ACK overrides
 * a person's Stop settling the mention; unknown is not final.
 */
import {
  MENTION_DELIVERY_TERMINAL_CODES,
  type AgentMentionDeliveryTerminalError,
  type AgentMentionDeliveryTransition,
  type MentionDeliveryEnvelope,
} from "@lrm/coforge-sdk/internal";
import type { PendingAgentDelivery } from "#src/server/db/repositories/direct-conversation.repositories.server";
import type {
  MentionAgentState,
  MentionDeliveryReportKey,
  MentionIdentity,
  MentionOutcome,
  MentionReasonCategory,
  PrismaMentionDeliveryRepository,
  TrackedMentionState,
} from "#src/server/db/repositories/mention-delivery.repositories.server";
import { publishPendingDelivery } from "./agent-delivery.server";

/** A pushed delivery as the issuer needs it. */
export type MentionDeliveryCandidate = {
  deliveryId: string;
  agentId: string;
  mentionsAgent: boolean;
};

/** Whether nothing stops the Agent from being woken: not stopped by a person, not deleted, and on
 * a Computer. */
function wakeable(agent: MentionAgentState) {
  return !agent.stoppedAt && !agent.deletedAt && agent.computerId !== null;
}

/** The Agent's running launch and native session, when it has both on its current Computer. */
function currentIdentity(agent: MentionAgentState): MentionIdentity | undefined {
  if (!wakeable(agent)) return undefined;
  const launchId = agent.launch?.launchId;
  const sessionId = agent.session?.nativeSessionId;
  if (
    !launchId ||
    !sessionId ||
    agent.launch?.computerId !== agent.computerId ||
    agent.session?.computerId !== agent.computerId
  )
    return undefined;
  return { launchId, sessionId, computerId: agent.computerId! };
}

function envelopeFor(messageId: string, identity: MentionIdentity): MentionDeliveryEnvelope {
  return {
    messageId,
    launchId: identity.launchId,
    sessionId: identity.sessionId,
    computerId: identity.computerId,
  };
}

const errorType = (error: unknown) => (error instanceof Error ? error.name : typeof error);

/** Issues tracked mentions as a send pushes them. */
export class MentionDeliveryIssuer {
  constructor(
    private readonly repository: Pick<
      PrismaMentionDeliveryRepository,
      "readIssuable" | "issue" | "clearEnvelopes"
    >,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Records each mentioning delivery and returns the envelope each push to a running Agent
   * carries, by delivery id: pending with an envelope for a running Agent, pending without one
   * for an Agent that is woken, and not launched at once for an Agent nothing may wake (stopped by
   * a person, deleted, or on no Computer). A delivery whose mention already settled keeps its
   * outcome and goes out without an envelope, so an idempotent replay of a send never reopens it.
   * One read and one transaction, however many Agents the message mentions. Never throws: when
   * issuing fails the pushes go out untracked, and no pending row keeps naming an envelope.
   */
  async issue(
    workspaceId: string,
    deliveries: readonly MentionDeliveryCandidate[],
  ): Promise<Map<string, MentionDeliveryEnvelope>> {
    const tracked = deliveries.filter((delivery) => delivery.mentionsAgent);
    if (!tracked.length) return new Map();
    const deliveryIds = tracked.map((delivery) => delivery.deliveryId);
    try {
      const rows = await this.repository.readIssuable(workspaceId, deliveryIds);
      const wakes: string[] = [];
      const enveloped: { deliveryId: string; messageId: string; identity: MentionIdentity }[] = [];
      for (const row of rows) {
        const identity = currentIdentity(row.agent);
        if (identity) enveloped.push({ ...row, identity });
        else if (wakeable(row.agent)) wakes.push(row.deliveryId);
      }
      const marked = await this.repository.issue(
        workspaceId,
        {
          deliveryIds: rows.map((row) => row.deliveryId),
          agentIds: rows.map((row) => row.agentId),
          wakes,
          enveloped,
        },
        this.now(),
      );
      return new Map(
        enveloped
          .filter((row) => marked.has(row.deliveryId))
          .map((row) => [row.deliveryId, envelopeFor(row.messageId, row.identity)]),
      );
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "mention_delivery:issue_failed",
          workspace_id: workspaceId,
          delivery_count: deliveryIds.length,
          error_type: errorType(error),
        }),
      );
      await this.repository.clearEnvelopes(workspaceId, deliveryIds).catch((clearError) =>
        console.warn(
          JSON.stringify({
            event: "mention_delivery:clear_envelopes_failed",
            workspace_id: workspaceId,
            error_type: errorType(clearError),
          }),
        ),
      );
      return new Map();
    }
  }
}

/** A delivery ACK as the transport hands it over, scoped to the reporting Computer. */
export type ReceivedDeliveryAck = {
  workspaceId: string;
  computerId: string;
  agentId: string;
  deliveryId: string;
  messageId: string;
  sequence: number;
  mentionDelivery?: MentionDeliveryEnvelope;
};

type DeliveryConversations = {
  receiveDeliveryAck(input: ReceivedDeliveryAck): Promise<TrackedMentionState>;
  readPendingAgentDeliveries(
    workspaceId: string,
    agentId: string,
    only?: { deliveryIds: readonly string[] },
  ): Promise<PendingAgentDelivery[]>;
};

/** How each terminal code a daemon reports settles a mention. The two identity codes are handled
 * apart: they may re-send before settling. */
const SETTLED_BY_CODE: Record<
  string,
  { outcome: Extract<MentionOutcome, "lost" | "unknown">; reason: MentionReasonCategory | null }
> = {
  [MENTION_DELIVERY_TERMINAL_CODES.INSTRUMENT_FAILED]: { outcome: "unknown", reason: null },
  [MENTION_DELIVERY_TERMINAL_CODES.DELIVERY_REJECTED]: { outcome: "lost", reason: "runtime_error" },
  [MENTION_DELIVERY_TERMINAL_CODES.UNSUPPORTED_DELIVERY_PATH]: {
    outcome: "lost",
    reason: "runtime_error",
  },
  [MENTION_DELIVERY_TERMINAL_CODES.QUOTA_LIMITED]: { outcome: "lost", reason: "quota" },
};
const UNCLASSIFIED = { outcome: "lost", reason: "unclassified" } as const;
const NOT_LAUNCHED = { outcome: "lost", reason: "not_launched" } as const;

/** Whether an ACK can still settle this tracked mention: sent with an envelope, and open or
 * settled only by a person's Stop. */
function settleableByAck(state: TrackedMentionState) {
  if (!state.mentionLaunchId) return false;
  if (state.mentionOutcome === "pending" || state.mentionOutcome === "unknown") return true;
  return (
    state.mentionOutcome === "lost" &&
    state.mentionReasonCategory === "not_launched" &&
    state.mentionTerminalCode === null
  );
}

/** Receives a daemon's reports on the deliveries it was pushed: ACKs and tracked-mention
 * transitions and terminal errors. A report is authorized by its delivery's Agent being on the
 * reporting Computer; an envelope naming another Computer is a drift. */
export class MentionDeliveryReports {
  constructor(
    private readonly repository: Pick<
      PrismaMentionDeliveryRepository,
      | "settleDrained"
      | "settleUnechoed"
      | "recordStage"
      | "readReported"
      | "settleTerminal"
      | "reissue"
    >,
    private readonly publisher: Parameters<typeof publishPendingDelivery>[0],
    private readonly conversations: DeliveryConversations,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Records the ACK (its refusal is the caller's), then settles a tracked mention it answers.
   * A mention that cannot be settled is logged and never fails the ACK. */
  async receiveDeliveryAck(ack: ReceivedDeliveryAck): Promise<void> {
    const state = await this.conversations.receiveDeliveryAck(ack);
    if (!settleableByAck(state)) return;
    try {
      await this.settleAck(ack);
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "mention_delivery:ack_settle_failed",
          workspace_id: ack.workspaceId,
          computer_id: ack.computerId,
          error_type: errorType(error),
        }),
      );
    }
  }

  async receiveTransition(transition: AgentMentionDeliveryTransition, computerId: string) {
    const key = reportKey({ ...transition, computerId }, transition.mentionDelivery);
    if (key.envelope.computerId === computerId)
      await this.repository.recordStage(key, transition.stage);
  }

  async receiveTerminalError(report: AgentMentionDeliveryTerminalError, computerId: string) {
    const key = reportKey({ ...report, computerId }, report.mentionDelivery);
    if (key.envelope.computerId !== computerId)
      return this.reissueForCurrentLaunch(key, MENTION_DELIVERY_TERMINAL_CODES.IDENTITY_DRIFT);
    if (report.code === MENTION_DELIVERY_TERMINAL_CODES.IDENTITY_UNKNOWN)
      return this.wakeWithoutEnvelope(key, report.code);
    if (report.code === MENTION_DELIVERY_TERMINAL_CODES.IDENTITY_DRIFT)
      return this.reissueForCurrentLaunch(key, report.code);
    await this.repository.settleTerminal(
      key,
      { ...(SETTLED_BY_CODE[report.code] ?? UNCLASSIFIED), code: report.code },
      this.now(),
    );
  }

  private async settleAck(ack: ReceivedDeliveryAck) {
    const envelope = ack.mentionDelivery;
    if (!envelope) {
      await this.repository.settleUnechoed(ack, this.now());
      return;
    }
    if (envelope.messageId !== ack.messageId) return;
    const key = reportKey(ack, envelope);
    if (envelope.computerId !== ack.computerId)
      await this.reissueForCurrentLaunch(key, MENTION_DELIVERY_TERMINAL_CODES.IDENTITY_DRIFT);
    else await this.repository.settleDrained(key, this.now());
  }

  /** The Agent was not running when its daemon got the envelope. Wake it the way an untracked
   * mention does, once, and leave the mention pending; an Agent nothing may wake was not
   * launched. */
  private async wakeWithoutEnvelope(key: MentionDeliveryReportKey, code: string) {
    const reported = await this.repository.readReported(key);
    if (!reported) return;
    if (!wakeable(reported.agent)) {
      await this.repository.settleTerminal(key, { ...NOT_LAUNCHED, code }, this.now());
      return;
    }
    if (await this.repository.reissue(key, undefined, code)) await this.resend(key, undefined);
  }

  /** The envelope named a launch, session or Computer that is no longer the Agent's. Issue it
   * once more for the current one; a second drift, or nothing newer to issue for, was not
   * launched. */
  private async reissueForCurrentLaunch(key: MentionDeliveryReportKey, code: string) {
    const reported = await this.repository.readReported(key);
    if (!reported) return;
    const identity = currentIdentity(reported.agent);
    const newer =
      identity &&
      (identity.launchId !== key.envelope.launchId ||
        identity.sessionId !== key.envelope.sessionId ||
        identity.computerId !== key.envelope.computerId);
    if (reported.terminalCode === code || !newer) {
      await this.repository.settleTerminal(key, { ...NOT_LAUNCHED, code }, this.now());
      return;
    }
    if (await this.repository.reissue(key, identity, code)) await this.resend(key, identity);
  }

  /** Pushes the same delivery again, received or not, with the new envelope or none. */
  private async resend(key: MentionDeliveryReportKey, identity: MentionIdentity | undefined) {
    const [delivery] = await this.conversations.readPendingAgentDeliveries(
      key.workspaceId,
      key.agentId,
      { deliveryIds: [key.deliveryId] },
    );
    if (!delivery) return;
    await publishPendingDelivery(this.publisher, key, delivery, {
      mentionDelivery: identity ? envelopeFor(delivery.messageId, identity) : undefined,
    });
  }
}

function reportKey(
  scope: { workspaceId: string; computerId: string; agentId: string; deliveryId: string },
  envelope: MentionDeliveryEnvelope,
): MentionDeliveryReportKey {
  return {
    workspaceId: scope.workspaceId,
    computerId: scope.computerId,
    agentId: scope.agentId,
    deliveryId: scope.deliveryId,
    envelope,
  };
}
