import { join } from "node:path";

const decoder = new TextDecoder();
let buffer = "";
let ignoreAbort = false;
const expectsAgentInstructions = process.argv.includes("expected-agent-instructions");
const sessionFlag = process.argv.indexOf("--session-dir");
const scopedSession =
  !process.argv.includes("expected-session-directory") ||
  (sessionFlag >= 0 &&
    process.argv[sessionFlag + 1] === join(process.cwd(), ".pi-sessions") &&
    Bun.env.HOME !== process.cwd() &&
    (await Bun.file(join(Bun.env.HOME ?? "", ".pi/agent/skills/proof/SKILL.md")).text()) ===
      "Global skill stays owned by the user.");

const resumeFlag = process.argv.indexOf("--session");
const sessionFile = process.argv[resumeFlag + 1];
if (
  process.argv.includes("expected-resume-session") &&
  !process.argv.includes("--session-id") &&
  (resumeFlag < 0 || sessionFile !== join(process.cwd(), ".pi-sessions", "local.jsonl"))
)
  throw new Error("resume must use the exact workspace session file");

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
  streamingBehavior?: string;
}): void {
  if (command.type === "get_state") {
    const selected = process.argv[process.argv.indexOf("--session") + 1];
    const fresh = process.argv.includes("--session-id")
      ? process.argv[process.argv.indexOf("--session-id") + 1]
      : undefined;
    const expectsResume = process.argv.includes("expect-resume") && !fresh;
    if (process.argv.includes("replay-rejected")) {
      write({
        type: "response",
        id: command.id,
        command: "get_state",
        success: false,
        error: "Cannot continue from message role: assistant",
      });
      return;
    }
    const promptFlag = process.argv.indexOf("--system-prompt");
    const instructions = promptFlag < 0 ? undefined : process.argv[promptFlag + 1];
    const environmentIsRestricted =
      scopedSession &&
      process.env.COFORGE_DECLARED_TEST_VALUE === "allowed" &&
      process.env.COFORGE_UNDECLARED_TEST_VALUE === undefined &&
      (!expectsAgentInstructions || instructions === "Test Agent instructions.");
    write({
      type: "response",
      id: command.id,
      command: "get_state",
      success:
        environmentIsRestricted &&
        (!expectsResume || selected?.endsWith("timestamp_selected-session.jsonl") || !!fresh),
      data: fresh
        ? { sessionId: fresh, sessionFile: null, messageCount: 0 }
        : resumeFlag >= 0
          ? {
              sessionId:
                process.argv.includes("wrong-resume-session") ||
                process.argv.includes("wrong-session")
                  ? "different"
                  : expectsResume
                    ? "selected-session"
                    : "local-full",
              sessionFile,
              messageCount: 1,
            }
          : { sessionId: "fixture-new", sessionFile: null, messageCount: 0 },
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
            thinkingLevelMap: {
              off: "off",
              low: "low",
              medium: "medium",
              high: "high",
            },
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
    if (command.message === "reject-notice") {
      write({
        type: "response",
        id: command.id,
        command: "prompt",
        success: false,
        error: "input rejected",
      });
      return;
    }
    if (command.message === "busy notice" && command.streamingBehavior !== "steer") {
      write({
        type: "response",
        id: command.id,
        command: "prompt",
        success: false,
        error: "steering required",
      });
      return;
    }
    if (command.message === "ignore-abort") ignoreAbort = true;
    write({
      type: "response",
      id: command.id,
      command: "prompt",
      success: true,
    });
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
      write({
        type: "tool_execution_end",
        toolCallId: "tool-1",
        isError: false,
      });
      write({ type: "agent_settled" });
    }
    return;
  }
  if (command.type === "clear_queue" || command.type === "abort") {
    if (ignoreAbort) return;
    write({
      type: "response",
      id: command.id,
      command: command.type,
      success: true,
    });
    if (command.type === "abort") write({ type: "agent_settled" });
  }
}

function write(value: unknown): void {
  console.log(JSON.stringify(value));
}
