/**
 * What the daemon itself knows about a failed Agent request that the failure class alone does not
 * say: whether repeating it is safe, whether its draft is saved, and the next step. A
 * `local_precondition` (`AgentPreflightError`) or a settled send (`AgentSendVerdictError`) may
 * carry one; `agent-proxy-failure.ts` classifies the failure as usual, then applies the verdict.
 */
export type AgentSendVerdict = Readonly<{
  retryable?: boolean;
  draftSaved?: boolean;
  suggestedNextAction?: string;
}>;

/**
 * A send failure the daemon has judged: `cause` is the transport failure it classifies by, and
 * `verdict` what settling the send established about it (see `agent-send-settlement.ts`).
 */
export class AgentSendVerdictError extends Error {
  readonly verdict: AgentSendVerdict;

  constructor(message: string, cause: unknown, verdict: AgentSendVerdict) {
    super(message, { cause });
    this.name = "AgentSendVerdictError";
    this.verdict = verdict;
  }
}
