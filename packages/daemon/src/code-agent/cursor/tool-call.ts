import { asRecord, nonEmptyString } from "#src/code-agent/json-record";

/**
 * How cursor-agent 2026.08.11's top-level `tool_call` frames read, from captured streams and the
 * CLI's own protobuf result types. A frame is `{type:"tool_call", subtype:"started"|"completed",
 * call_id, tool_call}`, and `tool_call` holds one `<kind>ToolCall` object (`shellToolCall`,
 * `readToolCall`, ...) next to bookkeeping keys. That object has `args` and, once completed,
 * `result`; a completed frame does not always repeat `args` (a failed read carries none). The
 * frame's own `call_id` matches a completion to its start: it is not a UUID, but the call id and
 * the model's function-call id joined by a newline.
 *
 * Nothing outside `tool_call.<kind>ToolCall.{args,result}` is read. In the CLI's source a completed
 * shell frame can also carry a top-level `env` snapshot of the process environment, and `result`
 * carries stdout, file contents, diffs, and search hits: only the fields named below move.
 */

const TOOL_CALL_SUFFIX = "ToolCall";

/** The `<kind>ToolCall` object of a `tool_call` frame: its kind (`shell`, `read`, `webSearch`),
 * arguments and result. `undefined` when the frame names no kind. */
export function cursorToolFrame(
  toolCall: unknown,
): { kind: string; args: unknown; result: unknown } | undefined {
  const record = asRecord(toolCall);
  if (!record) return undefined;
  for (const [key, value] of Object.entries(record)) {
    if (!key.endsWith(TOOL_CALL_SUFFIX) || key.length === TOOL_CALL_SUFFIX.length) continue;
    const body = asRecord(value);
    if (body) {
      return { kind: key.slice(0, -TOOL_CALL_SUFFIX.length), args: body.args, result: body.result };
    }
  }
  return undefined;
}

/** Cursor's own tool kinds and the CoForge tool each one is, with the single argument that carries
 * its summary. The argument names are the ones 2026.08.11 sends in `args` (`command`, `path`,
 * `pattern`, `globPattern`); the daemon core summarizes only its own canonical fields, so only
 * those move across. The shell `description` beside `args` is not moved. */
const CANONICAL_KINDS: Readonly<Record<string, { name: string; argument: [string, string] }>> = {
  shell: { name: "bash", argument: ["command", "command"] },
  read: { name: "read_file", argument: ["path", "file_path"] },
  edit: { name: "edit_file", argument: ["path", "file_path"] },
  grep: { name: "grep", argument: ["pattern", "pattern"] },
  glob: { name: "glob", argument: ["globPattern", "pattern"] },
};

/** The tool-start name and input for one Cursor tool call. A kind not in the table keeps its own
 * name and arguments, which the daemon core reports by name only. */
export function cursorToolCall(kind: string, args: unknown): { name: string; input: unknown } {
  // The kind is whatever the CLI names its tool, so it must not resolve on `Object.prototype`
  // (`constructor`).
  const canonical = Object.hasOwn(CANONICAL_KINDS, kind) ? CANONICAL_KINDS[kind] : undefined;
  if (!canonical) return { name: kind, input: args };
  const [from, to] = canonical.argument;
  const value = asRecord(args)?.[from];
  return { name: canonical.name, input: typeof value === "string" ? { [to]: value } : {} };
}

/** The text of a finished call: a shell call's `interleavedOutput` (stdout and stderr in the order
 * they were written, on both a success and a failure), or the message of an `error` result. A read
 * error names it `errorMessage`; the edit, grep, and glob errors name it `error` (an edit error's
 * `modelVisibleError` is the model's copy, not Activity). Nothing else in a result is output. */
export function cursorToolOutputText(kind: string, result: unknown): string | undefined {
  const outcome = asRecord(result);
  if (kind === "shell") {
    return nonEmptyString(
      (asRecord(outcome?.success) ?? asRecord(outcome?.failure))?.interleavedOutput,
    );
  }
  const error = asRecord(outcome?.error);
  return nonEmptyString(error?.errorMessage) ?? nonEmptyString(error?.error);
}

/** The failure arms of the CLI's shell, read, edit, grep, and glob results (`ShellResult`,
 * `EditResult`, ...): every arm of those results except `success`. `failure` and `error` were
 * captured; the rest are read from the CLI's protobuf definitions. A result holds one arm, next to
 * bookkeeping such as the shell's `isBackground`, so a key that is not listed is not a failure,
 * and neither is an arm of a kind this module does not map. */
const FAILURE_ARMS: ReadonlySet<string> = new Set([
  "failure",
  "error",
  "timeout",
  "rejected",
  "spawnError",
  "permissionDenied",
  "fileNotFound",
  "readPermissionDenied",
  "writePermissionDenied",
]);

/** Whether a finished call did not succeed. */
export function cursorToolFailed(result: unknown): boolean {
  const outcome = asRecord(result);
  return outcome !== undefined && Object.keys(outcome).some((arm) => FAILURE_ARMS.has(arm));
}
