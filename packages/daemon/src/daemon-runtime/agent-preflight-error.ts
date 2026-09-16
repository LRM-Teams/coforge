/**
 * A local precondition that failed before `DaemonRuntime` ever issued a request to the Web/backend
 * server: an invalid Agent local context, a runtime that is not started or connected, a missing
 * Agent API key, or a `--send-draft` request with no held draft. These are safe to describe to the
 * Agent (they name a caller-fixable local condition, never upstream/transport detail) and are
 * reported by `agent-proxy-failure.ts` as `local_precondition`, distinct from a transport failure.
 */
export class AgentPreflightError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "AgentPreflightError";
    this.code = code;
  }
}
