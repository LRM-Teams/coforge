export {};

const decoder = new TextDecoder();
let buffer = "";

for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).replace(/\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (line) await handle(JSON.parse(line) as { id: string; type: string; message?: string });
    newline = buffer.indexOf("\n");
  }
}

async function handle(command: { id: string; type: string; message?: string }) {
  if (command.type === "get_state" || command.type === "get_commands") {
    write({ type: "response", id: command.id, command: command.type, success: true, data: {} });
    await Bun.write(".e2e-agent-pid", String(process.pid));
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
