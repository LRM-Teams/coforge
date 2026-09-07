export {};

const promptFlag = process.argv.indexOf("--append-system-prompt-file");
if (promptFlag < 0) throw new Error("missing system prompt file option");
const promptPath = process.argv[promptFlag + 1];
if (!promptPath) throw new Error("missing system prompt file path");
const standingInstructions = await Bun.file(promptPath).text();
if (standingInstructions !== "Test Agent instructions.")
  throw new Error("missing Agent instructions");

const exitsOnInterrupt = process.argv.includes("exit-on-interrupt");
const decoder = new TextDecoder();
let buffer = "";
let inputSeen = false;
const eventFeed = Bun.env.COFORGE_CLAUDE_EVENT_FEED;
if (eventFeed) {
  void (async () => {
    while (true) {
      const response = await fetch(eventFeed);
      const records = (await response.json()) as Record<string, unknown>[];
      for (const record of records) write(record);
    }
  })();
}
// Register interrupt handling before responding to initialization.
process.on("SIGINT", () => {
  if (exitsOnInterrupt) process.exit(130);
  write({ type: "result", subtype: "success" });
});
const initialization = {
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
};
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
    if (request.subtype !== "initialize") throw new Error("wrong startup request");
    if (process.argv.includes("reject-initialize")) {
      write({
        type: "control_response",
        response: {
          subtype: "error",
          request_id: record.request_id,
          error: "initialization rejected",
        },
      });
      return;
    }
    write({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: record.request_id,
        response: { models: initialization.models },
      },
    });
    if (process.argv.includes("exit-after-init")) process.exit(1);
    return;
  }
  if (record.type === "user") {
    const message = record.message as Record<string, unknown>;
    if (record.session_id !== (inputSeen ? "fixture-session" : undefined))
      throw new Error("wrong session");
    const gate = !inputSeen && Bun.env.COFORGE_CLAUDE_INIT_GATE;
    inputSeen = true;
    if (gate) {
      void fetch(gate).then(() => {
        write(initialization);
        inputObserved();
      });
      return;
    }
    write(initialization);
    if (process.argv.includes("--replay-user-messages") || record.uuid !== undefined)
      throw new Error("unexpected input replay protocol");
    if (eventFeed) inputObserved();
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

function inputObserved(): void {
  write({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "fixture-input-observed" },
    },
  });
}

function write(value: unknown): void {
  console.log(JSON.stringify(value));
}
