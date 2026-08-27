import { readdir } from "node:fs/promises";
import { join } from "node:path";

const expectedSkill = process.argv
  .find((argument) => argument.startsWith("expected-skill="))
  ?.slice(15);
const skillsDirectory = join(process.cwd(), ".agents", "skills");
let skills: string[] = [];
try {
  skills = await readdir(skillsDirectory);
} catch {
  // No project skills were discovered.
}

const decoder = new TextDecoder();
let buffer = "";
let initialized = false;
let skillsLoaded = false;
let turn = 0;

for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).replace(/\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (line) handle(JSON.parse(line) as Request);
    newline = buffer.indexOf("\n");
  }
}

interface Request {
  id?: string;
  method: string;
  params?: Record<string, unknown>;
}

function handle(request: Request): void {
  if (request.method === "initialize" && request.id) {
    write({ id: request.id, result: { userAgent: "fixture" } });
    return;
  }
  if (request.method === "initialized") {
    initialized = true;
    return;
  }
  if (request.method === "skills/list" && request.id && initialized) {
    skillsLoaded = true;
    const cwds = request.params?.cwds;
    const errors =
      expectedSkill && !skills.includes(expectedSkill) ? ["missing expected skill"] : [];
    write({
      id: request.id,
      result: {
        data: [
          {
            cwd: Array.isArray(cwds) ? cwds[0] : undefined,
            skills: skills.map((name) => ({ name })),
            errors,
          },
        ],
      },
    });
    return;
  }
  if (request.method === "thread/start" && request.id && initialized && skillsLoaded) {
    write({ id: request.id, result: { thread: { id: "thread-1" } } });
    return;
  }
  if (request.method === "turn/start" && request.id) {
    if (textInput(request.params) === "invalid-turn") {
      write({ id: request.id, result: { turn: {} } });
      return;
    }
    turn += 1;
    const turnId = `turn-${turn}`;
    write({ id: request.id, result: { turn: { id: turnId, status: "inProgress" } } });
    write({
      method: "item/agentMessage/delta",
      params: { turnId, itemId: "message-1", delta: "Codex response" },
    });
    if (textInput(request.params) === "finish") {
      write({
        method: "item/started",
        params: { turnId, item: { id: "item-1", type: "commandExecution" } },
      });
      write({
        method: "item/commandExecution/outputDelta",
        params: { turnId, itemId: "item-1", delta: "tests passed" },
      });
      write({
        method: "item/completed",
        params: { turnId, item: { id: "item-1", type: "commandExecution", exitCode: 0 } },
      });
      write({
        method: "turn/completed",
        params: { turn: { id: turnId, status: "completed" } },
      });
    }
    return;
  }
  if (request.method === "turn/interrupt" && request.id) {
    write({ id: request.id, result: {} });
    write({
      method: "turn/completed",
      params: { turn: { id: request.params?.turnId, status: "interrupted" } },
    });
  }
}

function textInput(params: Record<string, unknown> | undefined): string | undefined {
  const input = params?.input;
  if (!Array.isArray(input)) return undefined;
  const first = input[0];
  if (first === null || typeof first !== "object") return undefined;
  return (first as { text?: string }).text;
}

function write(value: unknown): void {
  console.log(JSON.stringify(value));
}
