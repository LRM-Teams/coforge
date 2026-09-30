import { asRecord } from "#src/code-agent/json-record";

/**
 * How grok 1.0.41's `tool_call` / `tool_call_update` frames read, from captured streams. The user
 * guide (14-headless-mode.md) shows the leaf names but not these shapes: `rawOutput` is an object,
 * never text (`{type:"Bash", exit_code, timed_out, ...}`, `{type:"ReadFile", FileContent | FileNotFound}`),
 * and the display text is in `content` as `{type:"content", content:{type:"text", text}}` entries.
 */

/** The `rawInput` the daemon core reads. Grok's `read_file` names its path `target_file`, and the
 * core's file summary reads `file_path`; every other tool's input passes through unchanged. */
export function grokToolInput(toolName: string, rawInput: unknown): unknown {
  if (toolName !== "read_file") return rawInput;
  const input = asRecord(rawInput);
  if (typeof input?.target_file !== "string") return rawInput;
  const { target_file: path, ...rest } = input;
  return { ...rest, file_path: path };
}

/** The text of a finished call: its `content` text entries, joined. Only the terminal update's
 * `content` is output; the first update carries the command's description. */
export function grokToolOutputText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((entry) => {
      const item = asRecord(entry);
      const body = item?.type === "content" ? asRecord(item.content) : undefined;
      return body?.type === "text" && typeof body.text === "string" ? body.text : "";
    })
    .join("");
  return text || undefined;
}

/** Whether a finished call failed. Grok ends a call that could not run (a missing file) `failed`,
 * but a shell command that exits non-zero, or times out, still ends `completed` and says so in its
 * `Bash` `rawOutput`. */
export function grokToolFailed(status: unknown, rawOutput: unknown): boolean {
  if (status === "failed") return true;
  const output = asRecord(rawOutput);
  if (output?.type !== "Bash") return false;
  return (
    (typeof output.exit_code === "number" && output.exit_code !== 0) || output.timed_out === true
  );
}
