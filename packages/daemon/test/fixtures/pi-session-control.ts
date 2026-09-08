import { join } from "node:path";

// Deterministic native-protocol child: no model credentials or network calls.
const args = process.argv;
const sessionDir = args[args.indexOf("--session-dir") + 1]!;
const resume = args.indexOf("--session");
const sessionFile =
  resume >= 0 ? args[resume + 1]! : join(sessionDir, `${crypto.randomUUID()}.jsonl`);
const header =
  resume >= 0
    ? JSON.parse((await Bun.file(sessionFile).text()).split("\n")[0]!)
    : {
        type: "session",
        version: 3,
        id: crypto.randomUUID(),
        cwd: process.cwd(),
        timestamp: new Date().toISOString(),
      };
let persisted = resume >= 0;
await Bun.write(join(process.cwd(), ".control-child-pid"), String(process.pid));

async function handle(command: { id: string; type: string }) {
  let data: unknown = {};
  if (command.type === "get_state") {
    data = {
      sessionId: header.id,
      sessionFile: persisted ? sessionFile : null,
      messageCount: persisted ? 1 : 0,
    };
  } else if (command.type === "get_commands") {
    data = { commands: [] };
  } else if (command.type === "prompt") {
    await Bun.write(
      sessionFile,
      `${JSON.stringify(header)}\n${JSON.stringify({ type: "message", id: "fixture", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "Fixture attention" } })}\n`,
    );
    persisted = true;
  }
  console.log(
    JSON.stringify({
      type: "response",
      id: command.id,
      command: command.type,
      success: true,
      data,
    }),
  );
  if (command.type === "prompt" || command.type === "abort")
    console.log(JSON.stringify({ type: "agent_settled" }));
}

let buffer = "";
const decoder = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline: number;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim()) await handle(JSON.parse(line));
  }
}
