import { getLogger } from "@logtape/logtape";
import type { AgentSendReconciliationResponse } from "@lrm/coforge-sdk/agent";
import type { AgentMessageRequest } from "@lrm/coforge-sdk/internal";
import {
  adaptAgentSendCommittedResponse,
  type AgentMessageTransportResponse,
  type AgentSendReconciliationRequest,
} from "#src/connection/agent-http-clients";
import { AgentTransportError } from "#src/connection/agent-transport-error";
import { AgentSendVerdictError, type AgentSendVerdict } from "./agent-send-verdict";

const logger = getLogger(["coforge", "daemon", "runtime"]);

/** What settling one send needs: the send and reconcile calls, and whether the target's draft
 * still holds a given key. */
export type AgentSendSettlementPorts = {
  send(request: AgentMessageRequest): Promise<AgentMessageTransportResponse>;
  reconcile(request: AgentSendReconciliationRequest): Promise<AgentSendReconciliationResponse>;
  draftHoldsKey(target: string, idempotencyKey: string): Promise<boolean>;
};

/**
 * Issues one send and settles an ambiguous outcome by its key instead of retrying blind (Raft
 * 1.0.38). After a failure before any response, or a 5xx, one reconciliation asks the server
 * whether this key committed: `committed` is the send's success; `not_found` replays the original
 * request once under the same key. A failed reconciliation leaves the original failure, whose
 * delivery state stays unknown. A failed replay is retryable only while the target's draft still
 * holds this key, since only then does the retry reuse it.
 */
export async function settleAgentSend(
  send: AgentMessageRequest,
  ports: AgentSendSettlementPorts,
  options: { reviewerIsolation: boolean; logScope: Record<string, unknown> },
): Promise<AgentMessageTransportResponse> {
  let failure: unknown;
  try {
    return await ports.send(send);
  } catch (error) {
    if (!isAmbiguousSendFailure(error)) throw error;
    failure = error;
  }
  const logScope = {
    event: "agent.message.send_reconciled",
    ...options.logScope,
    target: send.target,
  };
  let reconciliation: AgentSendReconciliationResponse;
  try {
    reconciliation = await ports.reconcile({
      idempotencyKey: send.idempotencyKey,
      agentId: send.agentId,
      workspaceId: send.workspaceId,
      target: send.target,
    });
  } catch {
    logger.warn("Agent send outcome could not be reconciled", {
      ...logScope,
      outcome: "unknown",
      reconciliation: "unavailable",
    });
    throw failure;
  }
  // `outcome` keeps the documented vocabulary: a commit settles the send, `not_found` retries it.
  logger.info("Agent send outcome reconciled", {
    ...logScope,
    outcome: reconciliation.state === "committed" ? "ok" : "retry",
    reconciliation: reconciliation.state,
  });
  if (reconciliation.state === "committed") return adaptAgentSendCommittedResponse(reconciliation);
  try {
    return await ports.send(send);
  } catch (replayFailure) {
    const draftHoldsKey = await ports.draftHoldsKey(send.target, send.idempotencyKey);
    throw new AgentSendVerdictError(
      "the send's same-key replay failed after reconciliation found no commit",
      replayFailure,
      replayVerdict({
        idempotencyKey: send.idempotencyKey,
        target: send.target,
        draftHoldsKey,
        reviewerIsolation: options.reviewerIsolation,
      }),
    );
  }
}

/** A send whose request may have reached the server without its answer reaching the daemon: the
 * connection failed before any response began, or the server answered 5xx — whether or not its
 * body could then be read (Raft reconciles on the status alone). A failure after a successful
 * status started streaming, a refusal, or an undecodable answer is reported as it is. */
function isAmbiguousSendFailure(error: unknown): boolean {
  if (!(error instanceof AgentTransportError)) return false;
  return (
    error.failureClass === "pre_response_transport" ||
    (error.upstreamStatus !== undefined && error.upstreamStatus >= 500)
  );
}

function replayVerdict(details: {
  idempotencyKey: string;
  target: string;
  draftHoldsKey: boolean;
  reviewerIsolation: boolean;
}): AgentSendVerdict {
  if (!details.draftHoldsKey)
    return {
      retryable: false,
      draftSaved: false,
      suggestedNextAction:
        "Delivery is still UNKNOWN: the server reported this send's idempotency key absent, and " +
        "the same-key replay then failed. The target's draft no longer holds this send's key — " +
        "any draft there now belongs to a different send — so this send cannot be retried " +
        "safely. The state is CANNOT_CONFIRM and not retryable: do not resend on this evidence.",
    };
  const isolation = details.reviewerIsolation ? " --reviewer-isolation" : "";
  return {
    retryable: true,
    draftSaved: true,
    suggestedNextAction:
      "Delivery is still UNKNOWN: the server reported this send's idempotency key absent, and the " +
      "same-key replay then failed. The saved draft keeps that key, so retrying it cannot create " +
      `a second message: \`coforge message send${isolation} --send-draft --expected-draft-key ` +
      `${JSON.stringify(details.idempotencyKey)} --target ${JSON.stringify(details.target)}\`. ` +
      "The command checks the key again before sending anything and refuses if another send " +
      "replaced the draft.",
  };
}
