import type { AgentSessionOptions } from "@coforge/agent";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { asRecord, eventTime, nonEmptyString } from "#src/code-agent/json-record";
import type { TurnRecord } from "#src/code-agent/per-turn/turn-process";
import type {
  TurnCommand,
  TurnProtocol,
  TurnReader,
  TurnRequest,
  TurnScope,
} from "#src/code-agent/per-turn/turn-protocol";
import {
  cursorToolCall,
  cursorToolFailed,
  cursorToolFrame,
  cursorToolOutputText,
} from "./tool-call";

/**
 * Cursor CLI (`cursor-agent`): every turn is its own child process, with the prompt passed as the
 * final argv item (no stdin channel) and the turn ending when that process exits. There is no
 * native system-prompt flag, so the standing Agent instructions are the whole prompt of a fresh
 * session's very first turn; a resumed session never resends them.
 *
 * Cursor never fails a `--resume` of an unknown id: it silently starts a fresh chat under whatever
 * id its `system/init` frame reports. There is no missing-session recovery - the next turn simply
 * resumes whatever that frame named - and every `init` frame, including one that repeats the id, is
 * the session's identity report.
 */
export function createCursorTurnProtocol(
  options: AgentSessionOptions,
  command: readonly string[],
): TurnProtocol {
  return {
    provider: RUNTIME_PROVIDER.CURSOR,
    displayName: "Cursor",
    instructionsTurn: { identityNoun: "a session identity" },
    resumedIdentity: "resumable",
    repeatedSessionId: "reaffirm-and-report",
    identityReports: "every-completion",
    environment: { NO_COLOR: "1" },
    launch: (request) => cursorCommand(options, command, request),
    openTurn: (scope) => new CursorTurnReader(scope),
  };
}

function cursorCommand(
  options: AgentSessionOptions,
  command: readonly string[],
  request: TurnRequest,
): TurnCommand {
  const argv = [...command, "--print", "--output-format", "stream-json", "--force"];
  const model = options.runtime?.model;
  if (model && model !== "default") argv.push("--model", model);
  if (request.sessionId) argv.push("--resume", request.sessionId);
  argv.push(request.prompt);
  return { argv, input: { kind: "open" } };
}

/**
 * Maps only the frames CoForge's contract defines: `system/init` (session identity),
 * `system/status:compacting` and `system/compact_boundary` (compaction), `thinking` deltas,
 * `assistant` message content blocks (thinking/text/tool_use), `tool_call` frames (see
 * `cursor/tool-call.ts`), and `result` (turn outcome). `cursor-agent` 2026.08.11 reports every tool
 * as a `tool_call` frame and its `assistant` frames carry text only, so a call is never reported
 * twice; the `tool_use` block mapping serves a stream that puts tools in `assistant` messages.
 * Every other frame type the CLI emits in its stream-json output - measured `thinking:completed`,
 * `connection`, and `retry` frames, and the `user` echo of the prompt - carries no CoForge
 * Activity today.
 */
class CursorTurnReader implements TurnReader {
  readonly #scope: TurnScope;
  #failed = false;
  /** The `call_id`s of this turn's `tool_call` frames that have been reported, so that a repeated
   * frame is the same call and a completion still ends a call it had to start itself. */
  readonly #startedTools = new Set<string>();
  readonly #endedTools = new Set<string>();

  constructor(scope: TurnScope) {
    this.#scope = scope;
  }

  get failed(): boolean {
    return this.#failed;
  }

  read(record: TurnRecord): void {
    if (record.type === "system" && record.subtype === "init") {
      if (typeof record.session_id === "string" && record.session_id.trim()) {
        this.#scope.observeSessionId(record.session_id);
      }
      return;
    }
    if (record.type === "system" && record.subtype === "status" && record.status === "compacting") {
      this.#scope.emit({ type: "compaction-started", occurredAt: eventTime(record) });
      return;
    }
    if (record.type === "system" && record.subtype === "compact_boundary") {
      this.#scope.emit({ type: "compaction-finished", occurredAt: eventTime(record) });
      return;
    }
    // Current Cursor CLI versions emit reasoning as top-level `thinking` delta frames (rather
    // than assistant content blocks). Forward those deltas so the daemon's activity trajectory
    // can show Thinking/Thinking finished while a turn is running.
    if (
      record.type === "thinking" &&
      record.subtype === "delta" &&
      typeof record.text === "string" &&
      record.text
    ) {
      this.#scope.emit({ type: "thinking-delta", text: record.text });
      return;
    }
    if (record.type === "assistant") {
      this.#handleAssistant(record);
      return;
    }
    if (record.type === "tool_call") {
      this.#handleToolCall(record);
      return;
    }
    if (record.type === "result") {
      this.#handleResult(record);
    }
  }

  #handleAssistant(record: TurnRecord): void {
    const content = asRecord(record.message)?.content;
    if (!Array.isArray(content)) return;
    for (const raw of content) {
      const block = asRecord(raw);
      if (!block) continue;
      if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
        this.#scope.emit({ type: "thinking-delta", text: block.thinking });
      } else if (block.type === "text" && typeof block.text === "string" && block.text) {
        this.#scope.emit({ type: "text-delta", text: block.text });
      } else if (block.type === "tool_use") {
        this.#scope.emit({
          type: "tool-start",
          id: typeof block.id === "string" && block.id ? block.id : crypto.randomUUID(),
          name: typeof block.name === "string" && block.name ? block.name : "unknown_tool",
          input: block.input,
          occurredAt: eventTime(record),
        });
      }
    }
  }

  /** A `started` frame announces its call once, and the first `completed` frame for a call ends
   * it. Calls interleave, so `call_id` is the only match. A completion for a call whose start was
   * never seen announces it first, from the kind and arguments it carries (a failed read has
   * none). The call's output is only what `cursorToolOutputText` names. Cursor's frames carry a
   * millisecond `timestamp_ms` rather than the ISO `timestamp` `eventTime` reads, and the CLI
   * writes each frame as it happens, so the events take the daemon's observation time. */
  #handleToolCall(record: TurnRecord): void {
    const id = nonEmptyString(record.call_id);
    const frame = cursorToolFrame(record.tool_call);
    if (!id || !frame) return;
    const completed = record.subtype === "completed";
    if (!completed && record.subtype !== "started") return;
    if (!this.#startedTools.has(id)) {
      this.#startedTools.add(id);
      this.#scope.emit({ type: "tool-start", id, ...cursorToolCall(frame.kind, frame.args) });
    }
    if (!completed || this.#endedTools.has(id)) return;
    this.#endedTools.add(id);
    const output = cursorToolOutputText(frame.kind, frame.result);
    if (output) this.#scope.emit({ type: "tool-output", id, text: output });
    this.#scope.emit({ type: "tool-end", id, isError: cursorToolFailed(frame.result) });
  }

  /** The `result` frame only records whether the turn reported an error: the turn itself ends at
   * the process exit. */
  #handleResult(record: TurnRecord): void {
    const subtype = typeof record.subtype === "string" ? record.subtype : "success";
    if (subtype !== "success" || record.is_error === true) {
      const parts: string[] = [];
      if (Array.isArray(record.errors)) {
        for (const entry of record.errors) {
          if (typeof entry === "string" && entry.trim()) parts.push(entry.trim());
        }
      }
      if (typeof record.result === "string" && record.result.trim())
        parts.push(record.result.trim());
      this.#scope.emit({
        type: "error",
        message: parts.length > 0 ? parts.join(" | ") : "Execution failed",
      });
      this.#failed = true;
    } else {
      // The last `result` frame wins: a success after an error clears it.
      this.#failed = false;
    }
  }
}
