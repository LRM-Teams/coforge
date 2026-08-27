export {};

const decoder = new TextDecoder();
let buffer = "";
let ignoreAbort = false;

for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).replace(/\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (line) handle(JSON.parse(line) as { id: string; type: string; message?: string });
    newline = buffer.indexOf("\n");
  }
}

function handle(command: { id: string; type: string; message?: string }): void {
  if (command.type === "get_state") {
    const environmentIsRestricted =
      process.env.COFORGE_DECLARED_TEST_VALUE === "allowed" &&
      process.env.COFORGE_UNDECLARED_TEST_VALUE === undefined;
    write({
      type: "response",
      id: command.id,
      command: "get_state",
      success: environmentIsRestricted,
      data: {},
    });
    return;
  }
  if (command.type === "get_commands") {
    write({
      type: "response",
      id: command.id,
      command: "get_commands",
      success: true,
      data: {
        commands: [
          {
            name: "skill:fixture",
            description: "Fixture skill",
            source: "skill",
            sourceInfo: { source: "project", path: "/fixture/SKILL.md" },
          },
        ],
      },
    });
    if (process.env.COFORGE_EXIT_AFTER_READY === "1") setTimeout(() => process.exit(1), 0);
    return;
  }
  if (command.type === "prompt") {
    if (command.message === "ignore-abort") ignoreAbort = true;
    write({ type: "response", id: command.id, command: "prompt", success: true });
    write({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Pi response" },
    });
    if (command.message === "finish") {
      write({
        type: "tool_execution_start",
        timestamp: 1733234567890,
        toolCallId: "tool-1",
        toolName: "bash",
        args: { command: "printf safe" },
      });
      write({
        type: "tool_execution_update",
        toolCallId: "tool-1",
        partialResult: { content: [{ type: "text", text: "tests passed" }] },
      });
      write({ type: "tool_execution_end", toolCallId: "tool-1", isError: false });
      write({ type: "agent_settled" });
    }
    return;
  }
  if (command.type === "clear_queue" || command.type === "abort") {
    if (ignoreAbort) return;
    write({ type: "response", id: command.id, command: command.type, success: true });
    if (command.type === "abort") write({ type: "agent_settled" });
  }
}

function write(value: unknown): void {
  console.log(JSON.stringify(value));
}
