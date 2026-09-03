export {};

const exitsOnInterrupt = process.argv.includes("exit-on-interrupt");
const decoder = new TextDecoder();
let buffer = "";
// Register the interrupt handler before the init record becomes visible to the
// parent, so a SIGINT can never arrive while the handler is still unregistered.
process.on("SIGINT", () => {
  if (exitsOnInterrupt) process.exit(130);
  write({ type: "result", subtype: "success" });
});
write({
  type: "system",
  subtype: "init",
  session_id: "fixture-session",
  models: [
    {
      value: "claude-sonnet-5",
      displayName: "Sonnet 5",
      description: "Fast and capable",
      supportedEffortLevels: ["low", "medium", "high"],
      defaultEffortLevel: "high",
    },
  ],
});
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
    if (message.content === "usage") {
      write({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          rateLimitType: "five_hour",
          resetsAt: 1_788_490_800,
        },
      });
      write({ type: "result", subtype: "success" });
      return;
    }
    if (
      message.content !== "finish" &&
      message.content !== "New message available. Run coforge message check."
    )
      return;
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
