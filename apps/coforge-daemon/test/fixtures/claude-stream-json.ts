import { readdir } from "node:fs/promises";
import { join } from "node:path";

const expectedSkill = process.argv
  .find((argument) => argument.startsWith("expected-skill="))
  ?.slice(15);
const skillsDirectory = join(process.cwd(), ".claude", "skills");
let skills: string[] = [];
try {
  skills = await readdir(skillsDirectory);
} catch {
  // No project skills were discovered.
}

const decoder = new TextDecoder();
let buffer = "";
let initialized = false;
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).replace(/\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (line) handle(JSON.parse(line) as Record<string, unknown>);
    newline = buffer.indexOf("\n");
  }
}

function handle(record: Record<string, unknown>): void {
  if (record.type === "control_request") {
    const request = record.request as Record<string, unknown>;
    if (request.subtype === "initialize" && typeof record.request_id === "string" && !initialized) {
      initialized = true;
      const skillMissing = expectedSkill !== undefined && !skills.includes(expectedSkill);
      write({
        type: "control_response",
        response: {
          subtype: skillMissing ? "error" : "success",
          request_id: record.request_id,
          ...(skillMissing
            ? { error: "missing expected skill" }
            : { response: { commands: skills.map((name) => ({ name })) } }),
        },
      });
    }
    if (request.subtype === "interrupt" && typeof record.request_id === "string") {
      write({
        type: "control_response",
        response: { request_id: record.request_id, subtype: "success", response: {} },
      });
      write({ type: "result", subtype: "success", stop_reason: "interrupted" });
    }
    return;
  }
  if (record.type === "user") {
    if (!initialized) return;
    const message = record.message as Record<string, unknown>;
    if (message.content === "wait") return;
    if (message.content !== "finish") return;
    write({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Claude response" },
      },
    });
    write({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: {} }] },
    });
    write({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "tool-1", content: "tests passed", is_error: false },
        ],
      },
    });
    write({ type: "result", subtype: "success" });
    return;
  }
}

function write(value: unknown): void {
  console.log(JSON.stringify(value));
}
