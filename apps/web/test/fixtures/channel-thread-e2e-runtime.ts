import { mkdir } from "node:fs/promises";
import { run } from "../../../../packages/cli";
import { connectLocal } from "../../../../packages/cli/src/local-client";

const decoder = new TextDecoder();
let buffer = "";
let promptCount = 0;

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
    await mkdir(".pi-sessions", { recursive: true });
    await Bun.write(
      ".pi-sessions/channel-e2e.jsonl",
      `${JSON.stringify({ type: "session", id: "channel-e2e", cwd: process.cwd() })}\n`,
    );
    write({
      type: "response",
      id: command.id,
      command: command.type,
      success: true,
      data: command.type === "get_state" ? { sessionId: "channel-e2e" } : {},
    });
    await Bun.write(".e2e-channel-ready", "ready");
    return;
  }
  if (command.type === "set_model" || command.type === "set_thinking_level") {
    write({ type: "response", id: command.id, command: command.type, success: true });
    return;
  }
  if (command.type === "prompt") {
    write({ type: "response", id: command.id, command: command.type, success: true });
    promptCount++;
    await Bun.write(
      `.e2e-channel-prompt-${promptCount}.json`,
      JSON.stringify({ message: command.message }),
    );
    const planFile = Bun.file(".e2e-channel-plan.json");
    if (await planFile.exists()) {
      try {
        const plan = (await planFile.json()) as {
          result: string;
          cli?: string[][];
          operations: Array<{
            operation: "read" | "send" | "thread-unfollow";
            target: string;
            body?: string;
          }>;
        };
        const results = [];
        for (const args of plan.cli ?? []) {
          try {
            results.push(await run(args, connectLocal("", Bun.env.COFORGE_AGENT_CONTEXT!)));
          } catch (error) {
            results.push({ error: error instanceof Error ? error.message : String(error) });
          }
        }
        for (const operation of plan.operations) results.push(await call(operation));
        await Bun.write(plan.result, JSON.stringify(results));
        await planFile.delete();
      } catch (error) {
        await Bun.write(
          ".e2e-channel-error",
          error instanceof Error ? (error.stack ?? error.message) : String(error),
        );
      }
    }
    write({ type: "agent_settled" });
    return;
  }
  if (command.type === "clear_queue" || command.type === "abort") {
    write({ type: "response", id: command.id, command: command.type, success: true });
    if (command.type === "abort") write({ type: "agent_settled" });
  }
}

async function call(input: {
  operation: "read" | "send" | "thread-unfollow";
  target: string;
  body?: string;
}) {
  const response = await fetch(Bun.env.COFORGE_AGENT_PROXY_URL!, {
    method: "POST",
    headers: {
      authorization: `Bearer ${Bun.env.COFORGE_AGENT_CONTEXT}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...input, requestId: crypto.randomUUID() }),
  });
  if (!response.ok)
    throw new Error(`Agent proxy returned ${response.status}: ${await response.text()}`);
  return response.json();
}

function write(value: unknown) {
  console.log(JSON.stringify(value));
}
