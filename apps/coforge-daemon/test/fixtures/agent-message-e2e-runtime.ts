export {};

const descendant = Bun.spawn({
  cmd: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
});
const decoder = new TextDecoder();
let buffer = "";
const runtimeConfig = { modelProvider: "", model: "", reasoning: "" };

for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).replace(/\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (line)
      await handle(
        JSON.parse(line) as {
          id: string;
          type: string;
          message?: string;
          provider?: string;
          modelId?: string;
          level?: string;
        },
      );
    newline = buffer.indexOf("\n");
  }
}

async function handle(command: {
  id: string;
  type: string;
  message?: string;
  provider?: string;
  modelId?: string;
  level?: string;
}) {
  if (command.type === "get_state" || command.type === "get_commands") {
    write({ type: "response", id: command.id, command: command.type, success: true, data: {} });
    await Bun.write(".e2e-agent-pid", String(process.pid));
    await Bun.write(
      ".e2e-agent-processes.json",
      JSON.stringify({ directPid: process.pid, descendantPid: descendant.pid }),
    );
    return;
  }
  if (command.type === "set_model") {
    runtimeConfig.modelProvider = command.provider ?? "";
    runtimeConfig.model = command.modelId ?? "";
    await Bun.write(".e2e-runtime-config.json", JSON.stringify(runtimeConfig));
    write({ type: "response", id: command.id, command: command.type, success: true });
    return;
  }
  if (command.type === "set_thinking_level") {
    runtimeConfig.reasoning = command.level ?? "";
    await Bun.write(".e2e-runtime-config.json", JSON.stringify(runtimeConfig));
    write({ type: "response", id: command.id, command: command.type, success: true });
    return;
  }
  if (command.type === "prompt") {
    write({ type: "response", id: command.id, command: "prompt", success: true });
    if (command.message === "New message available. Run coforge message check.") {
      try {
        const checked = await call("check", "check-request");
        const target = checked.summaries?.[0]?.target;
        if (typeof target !== "string") throw new Error("attention target missing");
        const read = await call("read", "read-request", target);
        if (!read.messages?.some(({ body }) => body === "E2E User message"))
          throw new Error("canonical User message missing from read");
        const first = await call("send", "agent-reply-request", target, "E2E Agent reply");
        const retried = await call("send", "agent-reply-request", target, "E2E Agent reply");
        if (!first.messageId || !retried.messageId)
          throw new Error("Agent send message id missing");
        await Bun.write(
          ".e2e-agent-complete.json",
          JSON.stringify({
            firstMessageId: first.messageId,
            retriedMessageId: retried.messageId,
          }),
        );
        write({
          type: "tool_execution_start",
          toolCallId: "e2e-command",
          toolName: "bash",
          args: { command: "printf e2e-activity" },
        });
        write({
          type: "tool_execution_start",
          toolCallId: "e2e-read",
          toolName: "read",
          args: { path: "/workspace/e2e-read.ts" },
        });
        write({
          type: "tool_execution_start",
          toolCallId: "e2e-write",
          toolName: "write",
          args: { path: "/workspace/e2e-write.ts" },
        });
        write({
          type: "tool_execution_start",
          toolCallId: "e2e-edit",
          toolName: "edit",
          args: { path: "/workspace/e2e-edit.ts" },
        });
        write({
          type: "tool_execution_start",
          toolCallId: "e2e-tool",
          toolName: "web_search",
          args: { query: "CoForge" },
        });
        write({ type: "agent_settled" });
      } catch {
        process.exit(1);
      }
    }
    return;
  }
  if (command.type === "clear_queue" || command.type === "abort") {
    write({ type: "response", id: command.id, command: command.type, success: true });
    if (command.type === "abort") write({ type: "agent_settled" });
  }
}

async function call(
  operation: "check" | "read" | "send",
  requestId: string,
  target?: string,
  body?: string,
) {
  const response = await fetch(process.env.COFORGE_AGENT_PROXY_URL!, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.COFORGE_AGENT_CONTEXT}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ operation, requestId, target, body }),
  });
  if (!response.ok) throw new Error(`proxy failed: ${response.status}`);
  return (await response.json()) as {
    summaries?: Array<{ target?: string }>;
    messages?: Array<{ body?: string }>;
    messageId?: string;
  };
}

function write(value: unknown) {
  console.log(JSON.stringify(value));
}
