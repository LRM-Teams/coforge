export {};
const decoder = new TextDecoder();
let buffer = "";
write({ type: "system", subtype: "init", session_id: "fixture-session" });
process.on("SIGINT", () => write({ type: "result", subtype: "success" }));
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
  if (record.type === "user") {
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
      timestamp: "2026-01-02T03:04:05.000Z",
      message: {
        content: [
          { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "printf safe" } },
        ],
      },
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
