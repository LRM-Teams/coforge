/**
 * A local precondition that failed before `DaemonRuntime` ever issued a request to the Web/backend
 * server: an invalid Agent local context, a runtime that is not started or connected, a missing
 * Agent API key, or a `--send-draft` request with no held draft. These are safe to describe to the
 * Agent (they name a caller-fixable local condition, never upstream/transport detail) and are
 * reported by `agent-proxy-failure.ts` as `local_precondition`, distinct from a transport failure.
 *
 * `draftSaved` defaults to `undefined` (rendered as `false` by `agent-proxy-failure.ts`), matching
 * every existing preflight error, none of which persist a draft. The `--target-confirmed` guard is
 * the one caller that saves a draft before throwing and passes `true` explicitly.
 */
export class AgentPreflightError extends Error {
  readonly code: string;
  readonly draftSaved?: boolean;

  constructor(message: string, code: string, draftSaved?: boolean) {
    super(message);
    this.name = "AgentPreflightError";
    this.code = code;
    this.draftSaved = draftSaved;
  }
}
