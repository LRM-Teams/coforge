import type { AgentSessionOptions } from "@coforge/agent";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { asRecord, eventTime } from "#src/code-agent/json-record";
import type { TurnRecord } from "#src/code-agent/per-turn/turn-process";
import type {
  TurnCommand,
  TurnProtocol,
  TurnReader,
  TurnRequest,
  TurnScope,
} from "#src/code-agent/per-turn/turn-protocol";

/**
 * OpenCode (`opencode`, SST): every turn is its own `opencode run --format json` child process,
 * with the prompt as the final argv item. Resume is `--session <id>`, which OpenCode reports on its
 * own events (`sessionID`).
 *
 * The standing Agent instructions are the whole prompt of a fresh session's first turn: OpenCode
 * v2 reads a project's `AGENTS.md` itself and has no system-prompt flag, so there is no other
 * channel for them. A resumed session never resends them.
 */
export function createOpenCodeTurnProtocol(
  options: AgentSessionOptions,
  command: readonly string[],
): TurnProtocol {
  return {
    provider: RUNTIME_PROVIDER.OPENCODE,
    displayName: "OpenCode",
    instructionsTurn: { identityNoun: "a session identity" },
    resumedIdentity: "resumable",
    repeatedSessionId: "ignore",
    identityReports: "every-completion",
    environment: {
      // OpenCode resolves its discovery root (AGENTS.md walk-up, `.opencode/skills/`) from the
      // process working directory / `PWD`; v2 has no `--dir` flag, so the turn pins both (cwd is
      // passed to the spawn) and this override keeps an inherited `PWD` from pointing the Agent at
      // the wrong tree. Raft pins the same pair.
      PWD: options.agentWorkspaceDirectory,
      NO_COLOR: "1",
    },
    launch: (request) => openCodeCommand(options, command, request),
    openTurn: (scope) => new OpenCodeTurnReader(scope),
  };
}

function openCodeCommand(
  options: AgentSessionOptions,
  command: readonly string[],
  request: TurnRequest,
): TurnCommand {
  // OpenCode v2's `run` surface, verified against the released `2.0.x` CLI: `--auto` replaced
  // `--dangerously-skip-permissions`, the working directory is the process cwd (there is no
  // `--dir`), and the reasoning effort rides the model id as `provider/model#variant` (there is
  // no standalone `--variant`). `--format json` and `--session` are unchanged.
  const argv = [...command, "run", "--format", "json", "--auto"];
  const model = options.runtime?.model;
  // OpenCode calls the reasoning-effort selection a `variant`; the catalog's `variants` keys are
  // exactly what `#variant` accepts.
  const reasoning = options.runtime?.reasoning;
  if (model && model !== "default") {
    argv.push("--model", reasoning ? `${model}#${reasoning}` : model);
  }
  // A variant with no explicit model has nowhere to go in v2 (`#variant` needs a model id), so
  // it is dropped rather than invented; the runtime's own default model keeps its own effort.
  if (request.sessionId) argv.push("--session", request.sessionId);
  argv.push(request.prompt);
  // `opencode run` takes its prompt from argv and then waits for stdin EOF before it starts
  // working: with the daemon's `stdin: "pipe"` and nothing ever written, the turn sat on an open
  // pipe until dispose and the Agent looked permanently offline (verified: `< /dev/null`
  // completes in ~3s, an open pipe never produces output).
  return { argv, input: { kind: "eof" } };
}

/**
 * Maps the `--format json` events CoForge's contract defines: `text` (output), `tool_use` (tool
 * call and its result, which OpenCode reports on the same event), `error`, `step_start` (liveness)
 * and `step_finish`. Every event that carries `sessionID` establishes the session identity used
 * for resume.
 */
class OpenCodeTurnReader implements TurnReader {
  readonly #scope: TurnScope;
  #failed = false;

  constructor(scope: TurnScope) {
    this.#scope = scope;
  }

  get failed(): boolean {
    return this.#failed;
  }

  read(record: TurnRecord): void {
    const part = asRecord(record.part);
    const sessionId = reportedSessionId(record, part);
    if (sessionId) this.#scope.observeSessionId(sessionId);
    switch (record.type) {
      case "step_start": {
        this.#scope.emit({ type: "progress", occurredAt: eventTime(record) });
        return;
      }
      case "text": {
        const text = typeof part?.text === "string" ? part.text : "";
        if (text) this.#scope.emit({ type: "text-delta", text });
        return;
      }
      case "tool_use": {
        this.#handleToolUse(record, part);
        return;
      }
      case "error": {
        this.#scope.emit({ type: "error", message: openCodeErrorMessage(record) });
        this.#failed = true;
        return;
      }
      default:
        return;
    }
  }

  #handleToolUse(record: TurnRecord, part: Record<string, unknown> | undefined): void {
    const toolName = typeof part?.tool === "string" && part.tool ? part.tool : "unknown_tool";
    const id = typeof part?.callID === "string" && part.callID ? part.callID : crypto.randomUUID();
    const state = asRecord(part?.state);
    this.#scope.emit({
      type: "tool-start",
      id,
      name: toolName,
      input: state?.input,
      occurredAt: eventTime(record),
    });
    if (state?.status !== "completed" && state?.status !== "error") return;
    const output = state.output;
    if (typeof output === "string" && output) {
      this.#scope.emit({ type: "tool-output", id, text: output });
    }
    this.#scope.emit({ type: "tool-end", id, isError: state.status === "error" });
  }
}

/** The session id OpenCode reports, on the event or inside its part. */
function reportedSessionId(
  record: TurnRecord,
  part: Record<string, unknown> | undefined,
): string | undefined {
  for (const candidate of [record.sessionID, part?.sessionID]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return undefined;
}

/** OpenCode reports provider failures as `{ error: { name, data: { message } } }` (auth errors
 * carry the text there) and provider quota/HTTP failures as the top-level envelope the 2026-09-23
 * live capture showed: `{ error: { type: "provider.quota", message, status: 429 } }`. Prefer the
 * data message, then the classified kind plus the raw message, then the name — a bare
 * "Execution failed" here is exactly how a quota failure degraded into an unexplainable
 * "Agent runtime failed." (boss ruling: expose the real error). The classifier already maps
 * `rate.limit`/`429` text to the `rate_limited` reason, so the surfaced cause flows into the
 * Activity's class and retry decision unchanged. */
function openCodeErrorMessage(record: TurnRecord): string {
  const error = asRecord(record.error);
  const data = asRecord(error?.data);
  if (typeof data?.message === "string" && data.message.trim()) return data.message.trim();
  const kind = typeof error?.type === "string" ? error.type.trim() : "";
  const status = typeof error?.status === "number" ? ` (HTTP ${error.status})` : "";
  if (typeof error?.message === "string" && error.message.trim()) {
    const detail = error.message.trim();
    return kind ? `${kind}${status}: ${detail}` : detail;
  }
  if (kind) return `${kind}${status || ""}`.trim();
  if (typeof error?.name === "string" && error.name.trim()) return error.name.trim();
  return "Execution failed";
}
