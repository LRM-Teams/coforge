import { getLogger } from "@logtape/logtape";
import type { AgentSessionOptions } from "@coforge/agent";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { nonEmptyString } from "#src/code-agent/json-record";
import type { TurnRecord } from "#src/code-agent/per-turn/turn-process";
import type {
  TurnCommand,
  TurnExit,
  TurnProtocol,
  TurnReader,
  TurnRequest,
  TurnScope,
} from "#src/code-agent/per-turn/turn-protocol";
import { grokToolFailed, grokToolInput, grokToolOutputText } from "./tool-call";

const logger = getLogger(["coforge", "daemon", "code-agent", RUNTIME_PROVIDER.GROK]);

/** `end.stopReason` spellings that mean the turn was cancelled. The guide documents `cancelled`. */
const CANCELLED_STOP_REASONS: ReadonlySet<string> = new Set(["cancelled", "canceled", "aborted"]);
/** `end.stopReason` spellings that mean the turn ran out of model requests. The guide documents
 * `max_turn_requests`. */
const MAX_TURNS_STOP_REASONS: ReadonlySet<string> = new Set([
  "max_turn_requests",
  "max_turns",
  "maxturns",
  "max_turns_reached",
]);

/**
 * Grok Build (`grok`, xAI): every turn is its own `grok -p <prompt> --output-format streaming-json`
 * child process and the turn ends when that process exits. The stream is one `type`-tagged JSON
 * object per line, derived from the agent's ACP session updates (14-headless-mode.md,
 * "streaming-json").
 *
 * Grok has a system-prompt channel (`--rules` appends to the agent's system prompt), so the
 * standing Agent instructions ride every turn as rules and a fresh session needs **no bootstrap
 * turn** - nothing is spawned until real input arrives. Session identity is generated here (a UUID)
 * and pinned with `--session-id`, which creates a NEW session and refuses an id that is already in
 * use (14-headless-mode.md, "Named Sessions"); once a turn has been spawned with it, every later
 * turn carries `--resume <id>`, whatever that turn's outcome was. A resumed session's state is
 * `unknown`: grok may no longer have it (see `GrokTurnReader.lostResume`).
 */
export function createGrokTurnProtocol(
  options: AgentSessionOptions,
  command: readonly string[],
): TurnProtocol {
  return {
    provider: RUNTIME_PROVIDER.GROK,
    displayName: "Grok",
    resumedIdentity: "unknown",
    repeatedSessionId: "ignore",
    // The id is ours and is reported once it is known to resume, not on every completed turn.
    identityReports: "once-per-id",
    environment: {
      // Grok resolves its workspace from the process working directory; the override keeps an
      // inherited `PWD` from pointing the Agent at the wrong tree.
      PWD: options.agentWorkspaceDirectory,
      NO_COLOR: "1",
    },
    mintSessionId: () => crypto.randomUUID(),
    launch: (request) => grokCommand(options, command, request),
    openTurn: (scope, request) => new GrokTurnReader(scope, !request.creating),
  };
}

function grokCommand(
  options: AgentSessionOptions,
  command: readonly string[],
  request: TurnRequest,
): TurnCommand {
  // The one-shot headless surface (14-headless-mode.md): the prompt rides `-p`, and the process
  // exits when the turn ends. `--always-approve` and `--no-memory` are explicit: auto-approval, and
  // daemon-owned memory isolation. `--no-memory` and `--trust` are hidden flags (absent from
  // `grok --help`) that the 1.0 CLI accepts (verified on 1.0.40/1.0.41), and the guide's headless
  // flag table lists `--yolo` where this passes `--always-approve`.
  // `--trust` grants the Agent workspace folder trust for the turn. Headless startup loads
  // project skills and instructions only from a trusted folder (22-permissions-and-safety.md), and
  // the assigned skills are installed in the Agent workspace's `.grok/skills`. The grant is
  // recorded in `~/.grok/trusted_folders.toml`, and per 10-hooks.md it covers the folder's MCP and
  // LSP servers and hooks as well.
  const argv = [
    ...command,
    "-p",
    request.prompt,
    "--output-format",
    "streaming-json",
    "--always-approve",
    "--no-memory",
    "--trust",
  ];
  // `--rules` appends to the system prompt, which is per invocation: the standing instructions
  // ride every turn of this session, fresh or resumed.
  argv.push("--rules", options.instructions);
  const model = options.runtime?.model;
  if (model && model !== "default") argv.push("--model", model);
  const reasoning = options.runtime?.reasoning;
  if (reasoning) argv.push("--reasoning-effort", reasoning);
  // A grok session always has an id: it is chosen before the first turn (`mintSessionId`).
  const sessionId = request.sessionId;
  if (!sessionId) throw new Error("Grok launched a turn without a session id");
  argv.push(request.creating ? "--session-id" : "--resume", sessionId);
  // The prompt rides argv and the turn never writes stdin: close it at once so an inherited pipe
  // can never hold the turn open (the OpenCode turn sat on one until dispose, #652).
  return { argv, input: { kind: "eof" } };
}

/**
 * A `--resume` of an id grok has no session for fails with two stderr lines and no stdout frames:
 * `Session "<id>" not found locally, restoring conversation from remote...` and then
 * `Error: Failed to restore session from remote: ... 404 Not Found` (observed on 1.0.41;
 * 14-headless-mode.md says only that `--resume` "errors if the session does not exist"). grok
 * prints the first line whenever its local copy is missing, before it asks the remote, so only the
 * remote's 404 means the session is gone. A restore that fails for another reason - the remote
 * being down, say - fails the turn rather than discarding a session that may still exist.
 */
function isMissingSession(stderr: string): boolean {
  return /Failed to restore session from remote:.*\b404 Not Found\b/u.test(stderr);
}

/**
 * Maps the `streaming-json` events this adapter consumes (14-headless-mode.md, "streaming-json"):
 * `text` (output), `thought` (reasoning), `tool_call` and `tool_call_update` (tool activity),
 * `end` (turn boundary; carries the session id and the stop reason), `error`, and
 * `max_turns_reached`. The guide calls its event list non-exhaustive, so an event type this
 * adapter has no use for is ignored, never fatal.
 */
class GrokTurnReader implements TurnReader {
  readonly #scope: TurnScope;
  /** Whether this turn resumes a session, rather than creating it. */
  readonly #resumed: boolean;
  /** What the turn reported: nothing yet, a clean `end`, or a failure. */
  #outcome: "success" | "failed" | undefined;
  /** The tool calls this turn has announced, and those it has ended, by `toolCallId`. */
  readonly #startedTools = new Set<string>();
  readonly #endedTools = new Set<string>();

  constructor(scope: TurnScope, resumed: boolean) {
    this.#scope = scope;
    this.#resumed = resumed;
  }

  get failed(): boolean {
    return this.#outcome === "failed";
  }

  /** The resume was lost when grok died with no outcome and stderr says the remote has no such
   * session. An interrupted turn is not restarted: SIGINT kills grok at once with no frames. */
  lostResume(exit: TurnExit): boolean {
    return (
      !exit.interrupted &&
      this.#resumed &&
      this.#outcome === undefined &&
      exit.exitCode !== 0 &&
      isMissingSession(exit.stderrTail)
    );
  }

  read(record: TurnRecord): void {
    this.#observeSessionId(record);
    const data = typeof record.data === "string" ? record.data : "";
    switch (record.type) {
      case "text": {
        if (data) this.#scope.emit({ type: "text-delta", text: data });
        return;
      }
      case "thought": {
        if (data) this.#scope.emit({ type: "thinking-delta", text: data });
        return;
      }
      case "tool_call": {
        this.#handleToolCall(record);
        return;
      }
      case "tool_call_update": {
        this.#handleToolCallUpdate(record);
        return;
      }
      case "end": {
        this.#handleEnd(record.stopReason);
        return;
      }
      case "error": {
        const message =
          (typeof record.message === "string" && record.message.trim()) || data || "Grok error";
        this.#failTurn(message);
        return;
      }
      case "max_turns_reached": {
        this.#failTurn("Grok reached max turns");
        return;
      }
      // Documented frames with nothing to report: the tool and command lists, the plan, and the
      // per-response usage boundary (one per model response).
      case "available_commands":
      case "usage":
      case "plan": {
        return;
      }
      default: {
        // The guide names the `auto_compact_*` family without listing its members.
        if (typeof record.type === "string" && record.type.startsWith("auto_compact_")) return;
        logger.warning("Grok turn emitted an unrecognized event", {
          event: "code_agent.grok.unknown_event",
          type: typeof record.type === "string" ? record.type : "untyped",
          outcome: "unknown",
        });
        return;
      }
    }
  }

  /** Records the session id Grok reports on its `end` and `error` events; the id is also pinned
   * up front with `--session-id`, so a mismatched report means Grok replaced our id. */
  #observeSessionId(record: TurnRecord): void {
    const sessionId =
      typeof record.sessionId === "string" && record.sessionId.trim()
        ? record.sessionId.trim()
        : undefined;
    if (sessionId) this.#scope.observeSessionId(sessionId);
  }

  /** A `tool_call` opens a call. Its name is grok's own `toolName`, passed through for the daemon
   * core to turn into Activity, and its input is `rawInput` (see `grokToolInput`). */
  #handleToolCall(record: TurnRecord): void {
    const id = nonEmptyString(record.toolCallId);
    if (!id || this.#startedTools.has(id)) return;
    this.#startedTools.add(id);
    const name = nonEmptyString(record.toolName) ?? nonEmptyString(record.title) ?? "unknown_tool";
    this.#scope.emit({ type: "tool-start", id, name, input: grokToolInput(name, record.rawInput) });
  }

  /** A `tool_call_update` for a call this turn announced reports its status; the first terminal
   * one (`completed` or `failed`) ends the call, and only its `content` is the call's output. */
  #handleToolCallUpdate(record: TurnRecord): void {
    const id = nonEmptyString(record.toolCallId);
    const status = record.status;
    if (!id || !this.#startedTools.has(id) || this.#endedTools.has(id)) return;
    if (status !== "completed" && status !== "failed") return;
    this.#endedTools.add(id);
    const output = grokToolOutputText(record.content);
    if (output) this.#scope.emit({ type: "tool-output", id, text: output });
    this.#scope.emit({ type: "tool-end", id, isError: grokToolFailed(status, record.rawOutput) });
  }

  /** `end` is the last event of a turn, and its `stopReason` is one of `end_turn`, `max_tokens`,
   * `max_turn_requests`, `refusal` or `cancelled` (14-headless-mode.md). Only `end_turn` succeeds,
   * and it never undoes a failure an earlier `error` event already recorded. */
  #handleEnd(stopReason: unknown): void {
    const reason = typeof stopReason === "string" ? stopReason.toLowerCase() : "";
    if (CANCELLED_STOP_REASONS.has(reason)) {
      this.#failTurn(`Grok stopped: ${String(stopReason)}`);
    } else if (MAX_TURNS_STOP_REASONS.has(reason)) {
      this.#failTurn("Grok reached max turns");
    } else if (reason === "max_tokens") {
      this.#failTurn("Grok stopped: the response reached the output token limit (max_tokens)");
    } else if (reason === "refusal") {
      this.#failTurn("Grok stopped: the model refused to continue (refusal)");
    } else if (this.#outcome !== "failed") {
      this.#outcome = "success";
    }
  }

  #failTurn(message: string): void {
    this.#scope.emit({ type: "error", message });
    this.#outcome = "failed";
  }
}
