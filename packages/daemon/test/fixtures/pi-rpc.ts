export {};

const decoder = new TextDecoder();
let buffer = "";
let ignoreAbort = false;
const expectsCommunicationInstructions = process.argv.includes(
  "expected-communication-instructions",
);

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

function handle(command: {
  id: string;
  type: string;
  message?: string;
  provider?: string;
  modelId?: string;
  level?: string;
}): void {
  if (command.type === "get_state") {
    const instructions = process.env.COFORGE_AGENT_INSTRUCTIONS;
    const environmentIsRestricted =
      process.env.COFORGE_DECLARED_TEST_VALUE === "allowed" &&
      process.env.COFORGE_UNDECLARED_TEST_VALUE === undefined &&
      (!expectsCommunicationInstructions ||
        instructions?.startsWith("## CoForge communication") === true);
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
  if (command.type === "get_available_models") {
    write({
      type: "response",
      id: command.id,
      command: "get_available_models",
      success: true,
      data: {
        models: [
          {
            id: "claude-sonnet-4-6",
            name: "Claude Sonnet 4.6",
            provider: "anthropic",
            reasoning: true,
            thinkingLevelMap: { off: "off", low: "low", medium: "medium", high: "high" },
          },
        ],
      },
    });
    return;
  }
  if (command.type === "set_model") {
    write({
      type: "response",
      id: command.id,
      command: "set_model",
      success: command.provider === "anthropic" && command.modelId === "claude-sonnet-4-6",
    });
    return;
  }
  if (command.type === "set_thinking_level") {
    write({
      type: "response",
      id: command.id,
      command: "set_thinking_level",
      success: command.level === "high",
    });
    return;
  }
  if (command.type === "prompt") {
    if (command.message === "ignore-abort") ignoreAbort = true;
    write({ type: "response", id: command.id, command: "prompt", success: true });
    write({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Pi response" },
    });
    if (
      command.message === "finish" ||
      command.message === "New message available. Run coforge message check."
    ) {
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
