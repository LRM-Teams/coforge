/**
 * Tracked @mention delivery on the cloud side. Every delivery that personally mentions its Agent
 * is tracked on its delivery row. When the Agent has a running launch and session, the push
 * carries an envelope naming them, and the daemon answers it with an ACK echoing the envelope
 * (delivered) or a terminal error (lost with a reason category, or unknown). An Agent that is not
 * running is woken as before, without an envelope, and its mention stays pending; one nothing may
 * wake is not launched. Delivered and lost are final, except that a daemon's echoed ACK overrides
 * a person's Stop settling the mention; unknown is not final. A pending mention that went out
 * without an envelope, or with one for a launch that is no longer the Agent's, is issued again for
 * its current launch and session when a launch's session is accepted and when its daemon comes
 * back ready; nothing re-issues on a timer.
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
  MentionIssuePlan,
  MentionOutcome,
  MentionReasonCategory,
  PendingMention,
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
    private readonly repository: Pick<PrismaMentionDeliveryRepository, "issue" | "clearEnvelopes">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Records each mentioning delivery and returns the envelope each push to a running Agent
   * carries, by delivery id: pending with an envelope for a running Agent, pending without one
   * for an Agent that is woken, and not launched at once for an Agent nothing may wake (stopped by
   * a person, deleted, or on no Computer). The plan is made from the Agents' state as the issuing
   * transaction holds it. A delivery whose mention already settled keeps its outcome and goes out
   * without an envelope, so an idempotent replay of a send never reopens it. One transaction,
   * however many Agents the message mentions. Never throws: when issuing fails the pushes go out
   * untracked, and no pending row keeps naming an envelope.
   */
  async issue(
    workspaceId: string,
    deliveries: readonly MentionDeliveryCandidate[],
  ): Promise<Map<string, MentionDeliveryEnvelope>> {
    const tracked = deliveries.filter((delivery) => delivery.mentionsAgent);
    if (!tracked.length) return new Map();
    const deliveryIds = tracked.map((delivery) => delivery.deliveryId);
    try {
      const envelopes = new Map<string, MentionDeliveryEnvelope>();
      const marked = await this.repository.issue(
        workspaceId,
        deliveryIds,
        (mentions) => {
          const plan: MentionIssuePlan = { enveloped: [], wakes: [], notLaunched: [] };
          for (const mention of mentions) {
            const identity = currentIdentity(mention.agent);
            if (identity) {
              plan.enveloped.push({ deliveryId: mention.deliveryId, identity });
              envelopes.set(mention.deliveryId, envelopeFor(mention.messageId, identity));
            } else if (wakeable(mention.agent)) plan.wakes.push(mention.deliveryId);
            else plan.notLaunched.push(mention.deliveryId);
          }
          return plan;
        },
        this.now(),
      );
      return new Map([...envelopes].filter(([deliveryId]) => marked.has(deliveryId)));
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
    select?: { deliveryIds: readonly string[]; orUnreceived?: boolean },
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

/** An Agent on the Computer that reports for it. */
export type MentionAgentScope = { workspaceId: string; computerId: string; agentId: string };

/** The tracked deliveries a send goes out with: the envelope each carries, or none for a wake. */
type TrackedPushes = Map<string, MentionDeliveryEnvelope | undefined>;

/** An Agent's pending mentions after a re-issue: those issued just now for its current launch,
 * what each tracked one goes out with, and those a concurrent re-issue or drift answer took. */
type ReissuedMentions = { reissued: string[]; tracked: TrackedPushes; taken: Set<string> };

const NOTHING_REISSUED: ReissuedMentions = { reissued: [], tracked: new Map(), taken: new Set() };

/** Whether a mention went out as `identity` would issue it: with its envelope, or none without. */
function issuedFor(mention: PendingMention, identity: MentionIdentity | undefined) {
  return identity
    ? mention.mentionLaunchId === identity.launchId &&
        mention.mentionSessionId === identity.sessionId
    : mention.mentionLaunchId === null;
}

function sameIdentity(identity: MentionIdentity, envelope: MentionDeliveryEnvelope) {
  return (
    identity.launchId === envelope.launchId &&
    identity.sessionId === envelope.sessionId &&
    identity.computerId === envelope.computerId
  );
}

/**
 * Receives a daemon's reports on the deliveries it was pushed and on its Agents: ACKs,
 * tracked-mention transitions and terminal errors, a launch's accepted session, and its ready. A
 * delivery report is authorized by its delivery's Agent being on the reporting Computer; an
 * envelope naming another Computer is a drift. A pending mention that went out without an
 * envelope, or with one for another launch or session, is issued again for the Agent's current
 * ones when a session is accepted and when its daemon is ready; nothing re-issues on a timer.
 */
export class MentionDeliveryReports {
  constructor(
    private readonly repository: Pick<
      PrismaMentionDeliveryRepository,
      | "settleDrained"
      | "settleUnechoed"
      | "recordStage"
      | "settleTerminal"
      | "answerReported"
      | "readPending"
      | "reissuePending"
      | "settleStopped"
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
    if (key.envelope.computerId !== computerId) return this.answerDrift(key);
    if (report.code === MENTION_DELIVERY_TERMINAL_CODES.IDENTITY_UNKNOWN)
      return this.wakeWithoutEnvelope(key, report.code);
    if (report.code === MENTION_DELIVERY_TERMINAL_CODES.IDENTITY_DRIFT)
      return this.answerDrift(key);
    await this.repository.settleTerminal(
      key,
      { ...(SETTLED_BY_CODE[report.code] ?? UNCLASSIFIED), code: report.code },
      this.now(),
    );
  }

  /** A person stopped the Agent: its pending tracked mentions will not be launched. */
  async settleStopped(input: { workspaceId: string; agentId: string; stoppedAt: Date }) {
    await this.repository.settleStopped(input);
  }

  /** A launch's session was accepted as the Agent's current one: issues its pending mentions for
   * it and sends the ones it issued. Never throws: a failure is logged. */
  async resendForCurrentSession(scope: MentionAgentScope): Promise<void> {
    try {
      const { reissued, tracked } = await this.reissuePending(scope);
      if (reissued.length) await this.sendTracked(scope, { deliveryIds: reissued }, tracked);
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "mention_delivery:session_resend_failed",
          workspace_id: scope.workspaceId,
          computer_id: scope.computerId,
          agent_id: scope.agentId,
          error_type: errorType(error),
        }),
      );
    }
  }

  /**
   * The Agent's daemon is ready and the Agent running: sends it every delivery it has not
   * received and every mention just issued for its current launch, each tracked one with the
   * envelope issued for that launch. A mention a concurrent re-issue took is left to it.
   */
  async resendPending(scope: MentionAgentScope): Promise<void> {
    const { reissued, tracked, taken } = await this.reissuePending(scope);
    await this.sendTracked(scope, { deliveryIds: reissued, orUnreceived: true }, tracked, taken);
  }

  private async settleAck(ack: ReceivedDeliveryAck) {
    const envelope = ack.mentionDelivery;
    if (!envelope) {
      await this.repository.settleUnechoed(ack, this.now());
      return;
    }
    if (envelope.messageId !== ack.messageId) return;
    const key = reportKey(ack, envelope);
    if (envelope.computerId !== ack.computerId) await this.answerDrift(key);
    else await this.repository.settleDrained(key, this.now());
  }

  /** The Agent was not running when its daemon got the envelope. Wake it the way an untracked
   * mention does, once, and leave the mention pending; an Agent nothing may wake was not
   * launched. */
  private async wakeWithoutEnvelope(key: MentionDeliveryReportKey, code: string) {
    const answer = await this.repository.answerReported(
      key,
      (reported) =>
        wakeable(reported.agent)
          ? { reissue: undefined, code }
          : { settle: { ...NOT_LAUNCHED, code } },
      this.now(),
    );
    if (answer && "reissue" in answer)
      await this.sendTracked(
        key,
        { deliveryIds: [key.deliveryId] },
        new Map([[key.deliveryId, undefined]]),
      );
  }

  /**
   * The envelope named a launch, session or Computer that is no longer the Agent's. When the
   * cloud already knows a newer launch, the mention is issued for it at once, once per launch it
   * reached; otherwise it keeps pending without an envelope, and the next accepted session issues
   * it. Either way the outcome does not depend on whether the drift or the session came first.
   * Only an Agent nothing may wake settles, as not launched. The answer is read and written
   * while the Agent's row is held, so it never interleaves with a session being accepted.
   */
  private async answerDrift(key: MentionDeliveryReportKey) {
    const code = MENTION_DELIVERY_TERMINAL_CODES.IDENTITY_DRIFT;
    const answer = await this.repository.answerReported(
      key,
      (reported) => {
        if (!wakeable(reported.agent)) return { settle: { ...NOT_LAUNCHED, code } };
        const identity = currentIdentity(reported.agent);
        const newer =
          identity && !sameIdentity(identity, key.envelope) && reported.terminalCode !== code;
        return { reissue: newer ? identity : undefined, code };
      },
      this.now(),
    );
    if (answer && "reissue" in answer && answer.reissue)
      await this.sendTracked(
        key,
        { deliveryIds: [key.deliveryId] },
        new Map([[key.deliveryId, envelopeFor(key.envelope.messageId, answer.reissue)]]),
      );
  }

  /**
   * Issues the Agent's pending mentions that went out without an envelope or with one for another
   * launch or session, for its current ones. An Agent running without a session yet has those
   * envelopes cleared instead, so the wake it is sent is not taken for an ACK that lost its
   * envelope; an Agent nothing may wake is left to its Stop.
   */
  private async reissuePending(scope: MentionAgentScope): Promise<ReissuedMentions> {
    const read = await this.repository.readPending(scope.workspaceId, scope.agentId);
    if (!read || read.agent.computerId !== scope.computerId || !wakeable(read.agent))
      return NOTHING_REISSUED;
    const identity = currentIdentity(read.agent);
    const stale = read.mentions.filter((mention) => !issuedFor(mention, identity));
    const issued = new Set(await this.repository.reissuePending(scope, stale, identity));
    const tracked: TrackedPushes = new Map();
    const taken = new Set<string>();
    for (const mention of read.mentions) {
      if (issuedFor(mention, identity) || issued.has(mention.deliveryId))
        tracked.set(
          mention.deliveryId,
          identity ? envelopeFor(mention.messageId, identity) : undefined,
        );
      else taken.add(mention.deliveryId);
    }
    return { reissued: identity ? [...issued] : [], tracked, taken };
  }

  /**
   * Sends the Agent the deliveries `select` reads back (less those `skip` names), each tracked
   * one with what `tracked` gives it. An envelope that did not go out, because its delivery was
   * not read back or its send failed, is cleared, so the next accepted session or ready issues it
   * again.
   */
  private async sendTracked(
    scope: MentionAgentScope,
    select: { deliveryIds: readonly string[]; orUnreceived?: boolean },
    tracked: TrackedPushes,
    skip: ReadonlySet<string> = new Set(),
  ) {
    const deliveries = (
      await this.conversations.readPendingAgentDeliveries(scope.workspaceId, scope.agentId, select)
    ).filter((delivery) => !skip.has(delivery.deliveryId));
    const results = await Promise.allSettled(
      deliveries.map((delivery) =>
        publishPendingDelivery(
          this.publisher,
          scope,
          delivery,
          tracked.has(delivery.deliveryId)
            ? { mentionDelivery: tracked.get(delivery.deliveryId) }
            : undefined,
        ),
      ),
    );
    const sent = new Set(
      deliveries
        .filter((_, index) => results[index]!.status === "fulfilled")
        .map((delivery) => delivery.deliveryId),
    );
    const meant = new Set([
      ...select.deliveryIds,
      ...deliveries.map((delivery) => delivery.deliveryId),
    ]);
    const unsent: PendingMention[] = [];
    for (const deliveryId of meant) {
      const envelope = tracked.get(deliveryId);
      if (envelope && !sent.has(deliveryId))
        unsent.push({
          deliveryId,
          messageId: envelope.messageId,
          mentionLaunchId: envelope.launchId,
          mentionSessionId: envelope.sessionId,
        });
    }
    if (unsent.length) await this.repository.reissuePending(scope, unsent, undefined);
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
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
