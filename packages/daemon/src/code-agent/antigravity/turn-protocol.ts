import type { AgentSessionOptions } from "@coforge/agent";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { asRecord } from "#src/code-agent/json-record";
import type { TurnRecord } from "#src/code-agent/per-turn/turn-process";
import type {
  TurnCommand,
  TurnProtocol,
  TurnReader,
  TurnRequest,
  TurnScope,
} from "#src/code-agent/per-turn/turn-protocol";
import { withoutSshSessionVariables } from "./ssh-environment";
import { antigravityToolCall } from "./tool-call";

/** How long one headless turn may run. agy's own default is unlimited, and it keeps a turn open
 * for the agent's background tasks until this deadline (capped at 30 minutes by agy itself). */
const PRINT_TIMEOUT = "30m";

const INTERRUPTED_STATUSES: ReadonlySet<unknown> = new Set(["INTERRUPTED", "CANCELED"]);

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/**
 * Google's Antigravity CLI (`agy`): every turn is one headless
 * `agy --input-format stream-json --output-format stream-json` process that reads the prompt from
 * stdin and exits when the turn ends. A conversation continues with `--conversation <id>`, the id
 * each turn's `init` frame reports. agy has no system-prompt flag, so the standing Agent
 * instructions are the whole prompt of a fresh conversation's first turn; a resumed conversation
 * never resends them.
 */
export function createAntigravityTurnProtocol(
  options: AgentSessionOptions,
  command: readonly string[],
): TurnProtocol {
  return {
    provider: RUNTIME_PROVIDER.ANTIGRAVITY,
    displayName: "Antigravity",
    instructionsTurn: { identityNoun: "a conversation" },
    resumedIdentity: "resumable",
    // A resumed turn names the conversation already reported: the turn's completion reports it.
    repeatedSessionId: "reaffirm",
    identityReports: "every-completion",
    sanitizeEnvironment: withoutSshSessionVariables,
    environment: { NO_COLOR: "1" },
    launch: (request) => antigravityCommand(options, command, request),
    openTurn: (scope) => new AntigravityTurnReader(scope),
  };
}

function antigravityCommand(
  options: AgentSessionOptions,
  command: readonly string[],
  request: TurnRequest,
): TurnCommand {
  const argv = [
    ...command,
    "--print=",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
    "--print-timeout",
    PRINT_TIMEOUT,
  ];
  const model = options.runtime?.model;
  if (model && model !== "default") argv.push("--model", model);
  if (request.sessionId) argv.push("--conversation", request.sessionId);
  // The prompt is one `stream-json` user line on stdin, closed straight after it, so agy runs
  // exactly one turn and the prompt never appears in argv or a process listing.
  return {
    argv,
    input: {
      kind: "line",
      text: JSON.stringify({ event: "user", message: { content: request.prompt } }),
    },
  };
}

class AntigravityTurnReader implements TurnReader {
  readonly #scope: TurnScope;
  /** The `init` frame named another conversation than the one this turn resumed. */
  #lost = false;
  #resultFailed = false;
  /** The tool steps this turn has announced, and those it has ended, by `step_index`. */
  readonly #startedTools = new Set<number>();
  readonly #endedTools = new Set<number>();

  constructor(scope: TurnScope) {
    this.#scope = scope;
  }

  get failed(): boolean {
    return this.#resultFailed;
  }

  lostResume(): boolean {
    return this.#lost;
  }

  read(record: TurnRecord): void {
    if (record.event === "init") this.#handleInit(record.conversation_id);
    else if (record.event === "step_update") this.#handleStep(asRecord(record.step_update));
    else if (record.event === "result") this.#handleResult(asRecord(record.result));
  }

  #handleInit(conversationId: unknown): void {
    if (typeof conversationId !== "string" || !conversationId.trim()) return;
    const resumed = this.#scope.sessionId();
    if (resumed && conversationId !== resumed) {
      // agy answers a `--conversation` it cannot find with a stderr warning and a brand-new
      // conversation that never saw the standing instructions (observed on 1.2.12/1.2.13; the
      // headless docs do not say). Discard that turn; once it has exited, a fresh conversation
      // is bootstrapped and the same input is sent into it.
      this.#lost = true;
      this.#scope.abandon();
      return;
    }
    this.#scope.observeSessionId(conversationId);
  }

  /** `agent_response` steps carry the reply as `text_delta`s. Each `tool` step, and each
   * `subagent` step that hands work to subagents, is announced once and ended once, whether agy
   * reports it ACTIVE first or only DONE. A subagent runs on its own: its steps are not in this
   * stream, and its report arrives later as a `system_message`. Its task and the subagents' local
   * paths are not Activity, so it starts with no input. Other step types (`user_input`,
   * `system_message`, `checkpoint`) carry no Activity. */
  #handleStep(step: Record<string, unknown> | undefined): void {
    if (!step) return;
    if (step.step_type === "agent_response") {
      const text = nonEmpty(step.text_delta);
      if (text) this.#scope.emit({ type: "text-delta", text });
      return;
    }
    const subagent = step.step_type === "subagent";
    if ((!subagent && step.step_type !== "tool") || typeof step.step_index !== "number") return;
    const index = step.step_index;
    const info = asRecord(step.tool_info);
    const id = `${this.#scope.sessionId() ?? "agy"}:${index}`;
    if (!this.#startedTools.has(index)) {
      this.#startedTools.add(index);
      const name = nonEmpty(step.tool_name) ?? nonEmpty(info?.name) ?? "unknown_tool";
      this.#scope.emit({
        type: "tool-start",
        id,
        ...(subagent ? { name, input: {} } : antigravityToolCall(name, info?.parameters)),
      });
    }
    if (step.state !== "DONE" || this.#endedTools.has(index)) return;
    this.#endedTools.add(index);
    // A failed step carries an `error` object with `type` and `message` (headless docs).
    const error = asRecord(info?.error);
    const output = error
      ? (nonEmpty(error.message) ?? nonEmpty(error.type))
      : nonEmpty(info?.output);
    if (output) this.#scope.emit({ type: "tool-output", id, text: output });
    this.#scope.emit({ type: "tool-end", id, isError: error !== undefined });
  }

  /** The `result` frame only records whether the turn failed: the turn itself ends at the process
   * exit. */
  #handleResult(result: Record<string, unknown> | undefined): void {
    if (!result) return;
    // agy answers the SIGINT of `interrupt()` with an INTERRUPTED (or CANCELED) result; that is
    // the requested stop, which the turn's exit reports as interrupted, not a runtime error.
    if (this.#scope.interrupting() && INTERRUPTED_STATUSES.has(result.status)) return;
    this.#resultFailed = result.status !== "SUCCESS";
    if (!this.#resultFailed) return;
    const status = nonEmpty(result.status) ?? "unknown";
    this.#scope.emit({
      type: "error",
      message: nonEmpty(result.error)?.trim() || `Antigravity turn ended with status ${status}`,
      providerErrorCode: status,
    });
  }
}
