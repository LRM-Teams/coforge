import { getLogger } from "@logtape/logtape";
import type { AgentSendReconciliationResponse } from "@lrm/coforge-sdk/agent";
import type { AgentMessageRequest } from "@lrm/coforge-sdk/internal";
import {
  adaptAgentSendCommittedResponse,
  type AgentMessageTransportResponse,
  type AgentSendReconciliationRequest,
} from "#src/connection/agent-http-clients";
import { AgentExplainedRefusalError } from "#src/connection/agent-explained-refusal-error";
import { AgentTransportError } from "#src/connection/agent-transport-error";
import { diagnosticErrorCode } from "#src/platform/diagnostic-error-code";
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
 * holds this key, since only then does the retry reuse it; a draft that cannot be checked does not.
 * A refusal because an earlier request with this key is still being processed is unknown delivery
 * too, retryable under the draft's key for the same reason: once another send replaced the draft,
 * that send cannot be retried safely.
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
    if (isStillProcessing(error))
      throw new AgentSendVerdictError(
        "an earlier request with the send's key is still being processed",
        error,
        stillProcessingVerdict({
          idempotencyKey: send.idempotencyKey,
          target: send.target,
          draftHoldsKey: await draftStillHoldsKey(send, ports, options.logScope),
          reviewerIsolation: options.reviewerIsolation,
        }),
      );
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
    const draftHoldsKey = await draftStillHoldsKey(send, ports, options.logScope);
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

/** The server refused this request because an earlier one with the same key is still working. */
function isStillProcessing(error: unknown): error is AgentExplainedRefusalError {
  return (
    error instanceof AgentExplainedRefusalError && error.code === "MESSAGE_REQUEST_IN_PROGRESS"
  );
}

/** Whether the target's draft still holds the send's key. A draft that cannot be checked is
 * answered as not holding it, the safe answer: only a draft holding the key can be sent again. */
async function draftStillHoldsKey(
  send: { idempotencyKey: string; target: string },
  ports: AgentSendSettlementPorts,
  logScope: Record<string, unknown>,
): Promise<boolean> {
  try {
    return await ports.draftHoldsKey(send.target, send.idempotencyKey);
  } catch (error) {
    logger.warn("Agent send draft could not be checked", {
      event: "agent.message.send_draft_unchecked",
      ...logScope,
      target: send.target,
      error_code: diagnosticErrorCode(error),
    });
    return false;
  }
}

/** An earlier request with this key may still commit, so delivery is unknown. While the saved draft
 * holds the key, `--expected-draft-key` keeps a resend from sending a draft that replaced it; once
 * another send replaced the draft, no command can retry this send. */
function stillProcessingVerdict(details: {
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
        "Delivery is UNKNOWN: an earlier request with this send's idempotency key is still being " +
        "processed, so this message may still be delivered. The target's draft no longer holds " +
        "this send's key — any draft there now belongs to a different send — so this send cannot " +
        "be retried safely. The state is CANNOT_CONFIRM and not retryable: do not resend, and do " +
        "not write it again as a new send. To look for it, run `coforge message read --target " +
        `${JSON.stringify(details.target)}\`: a matching message is not proof that this send ` +
        "committed, and not seeing it proves nothing yet. Wait, or ask a person.",
    };
  const isolation = details.reviewerIsolation ? " --reviewer-isolation" : "";
  return {
    retryable: true,
    draftSaved: true,
    suggestedNextAction:
      "An earlier request with this send's idempotency key is still being processed, so this " +
      "message may still be delivered. Do not write it again as a new send. Wait a moment, then " +
      `run \`coforge message send${isolation} --send-draft --expected-draft-key ` +
      `${JSON.stringify(details.idempotencyKey)} --target ${JSON.stringify(details.target)}\`: it ` +
      "reuses the same key, so it cannot create a second message, and it refuses if another " +
      "send replaced the draft.",
  };
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
