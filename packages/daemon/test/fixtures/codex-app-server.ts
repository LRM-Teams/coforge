import { readdir } from "node:fs/promises";
import { join } from "node:path";

const expectedSkill = process.argv
  .find((argument) => argument.startsWith("expected-skill="))
  ?.slice(15);
const expectsCoforgeEnvironment = process.argv.includes("expected-coforge-environment");
const expectsRuntimeConfig = process.argv.includes("expected-runtime-config");
const usageUnavailable = process.argv.includes("usage-unavailable");
const usageUnsupported = process.argv.includes("usage-unsupported");
const usageTimeout = process.argv.includes("usage-timeout");
const usageClient = process.argv.some((argument) => argument.startsWith("usage"));
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
    const clientInfo = request.params?.clientInfo as Record<string, unknown> | undefined;
    const capabilities = request.params?.capabilities as Record<string, unknown> | undefined;
    const expectedClient = usageClient
      ? { name: "coforge-daemon-usage", title: "CoForge Daemon Usage" }
      : { name: "coforge_daemon", title: "CoForge Daemon" };
    if (
      clientInfo?.name !== expectedClient.name ||
      clientInfo.title !== expectedClient.title ||
      typeof clientInfo.version !== "string" ||
      capabilities?.experimentalApi !== false
    ) {
      write({ id: request.id, error: { code: "invalid_params", message: "invalid initialize" } });
      return;
    }
    write({ id: request.id, result: { userAgent: "fixture" } });
    return;
  }
  if (request.method === "initialized") {
    initialized = true;
    return;
  }
  if (request.method === "account/rateLimits/read" && request.id) {
    if (usageTimeout) return;
    if (usageUnavailable || usageUnsupported) {
      write({ id: request.id, error: { code: "not_logged_in", message: "not logged in" } });
      return;
    }
    write({
      id: request.id,
      result: {
        planType: "plus",
        rateLimits: {
          primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_735_780_800 },
          secondary: {
            usedPercent: 75,
            windowDurationMins: 10_080,
            resetsAt: "2026-01-09T00:00:00.000Z",
          },
        },
      },
    });
    return;
  }
  if (request.method === "model/list" && request.id && initialized) {
    write({
      id: request.id,
      result: {
        data: [
          {
            model: "gpt-5.6-sol",
            displayName: "GPT-5.6 Sol",
            description: "Primary coding model",
            isDefault: true,
            supportedReasoningEfforts: [
              { reasoningEffort: "low" },
              { reasoningEffort: "medium" },
              { reasoningEffort: "high" },
            ],
            defaultReasoningEffort: "low",
          },
        ],
        nextCursor: null,
      },
    });
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
    if (expectsCoforgeEnvironment && !hasCoforgeEnvironmentPolicy(request.params)) {
      write({ id: request.id, error: { message: "missing CoForge shell environment policy" } });
      return;
    }
    if (expectsRuntimeConfig && !hasRuntimeConfig(request.params)) {
      write({ id: request.id, error: { message: "missing selected runtime config" } });
      return;
    }
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
    if (
      textInput(request.params) === "finish" ||
      textInput(request.params) === "New message available. Run coforge message check."
    ) {
      write({
        method: "item/started",
        timestamp: "2026-01-02T03:04:05.000Z",
        params: {
          turnId,
          item: { id: "item-1", type: "commandExecution", command: "printf safe" },
        },
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
    } else if (textInput(request.params) === "files") {
      write({
        method: "item/started",
        timestamp: "2026-01-02T03:04:05.000Z",
        params: {
          turnId,
          item: {
            id: "item-2",
            type: "fileChange",
            changes: [
              { kind: "add", path: "src/new.ts" },
              { kind: "update", path: "src/existing.ts" },
            ],
          },
        },
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

function hasCoforgeEnvironmentPolicy(params: Record<string, unknown> | undefined): boolean {
  const config = record(params?.config);
  const policy = record(config?.shell_environment_policy);
  const filters = record(policy?.filters);
  return (
    config?.allow_login_shell === false &&
    policy?.inherit === "all" &&
    policy.ignore_default_excludes === false &&
    filters?.["COFORGE_*"] === "include" &&
    filters.PATH === "include" &&
    filters.HOME === "include"
  );
}

function hasRuntimeConfig(params: Record<string, unknown> | undefined): boolean {
  const config = record(params?.config);
  return params?.model === "gpt-5.6-sol" && config?.model_reasoning_effort === "high";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function write(value: unknown): void {
  console.log(JSON.stringify(value));
}
