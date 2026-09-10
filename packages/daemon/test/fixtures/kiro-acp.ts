import { join } from "node:path";
import { readdir } from "node:fs/promises";

type Message = {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
};
const sid = "sess-fixture-kiro";
if (process.argv.includes("--agent")) process.exit(2);
const catalog = process.argv.includes("--catalog");
const delayedConfig = process.argv.includes("--delayed-config");
const earlyConfig = process.argv.includes("--early-config");
const missingConfig = process.argv.includes("--missing-config");
const closedConfig = process.argv.includes("--closed-config");
let modelsReady = !(delayedConfig || earlyConfig || missingConfig || closedConfig);
const agent = catalog
  ? "vibe"
  : (await readdir(join(process.cwd(), ".kiro/agents")))
      .find((name) => name.startsWith("coforge-runtime-"))!
      .replace(/\.json$/, "");
let configured = false;
let model = "auto";
let effort = "low";
const createdAt = "2026-08-01T02:03:04.000Z";
const configOptions = () =>
  [
    {
      id: "mode",
      name: "Mode",
      type: "select",
      currentValue: configured ? agent : "vibe",
      options: [{ value: agent, name: agent }],
    },
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: model,
      options: [
        { value: "auto", name: "Auto" },
        {
          value: "model-reasoning",
          name: "Reasoning",
          _meta: { kiro: { effortLevels: ["low", "high"], defaultEffortLevel: "low" } },
        },
      ],
    },
    ...(model === "auto"
      ? []
      : [
          {
            id: "effortLevel",
            name: "Effort",
            category: "thought_level",
            type: "select",
            currentValue: effort,
            options: [
              { value: "low", name: "Low" },
              { value: "high", name: "High" },
            ],
          },
        ]),
  ].filter((option) => modelsReady || option.id === "mode");
let active: Message | undefined;
let replaced: Message | undefined;
let admissions = 0;
let clientRequestId = 1000;
const permissionRequests = new Map<number, string | undefined>();
const write = (message: object) => console.log(JSON.stringify({ jsonrpc: "2.0", ...message }));
const result = (request: Message, value: unknown) => write({ id: request.id, result: value });
const update = (value: object) =>
  write({ method: "session/update", params: { sessionId: sid, update: value } });

async function handle(request: Message) {
  switch (request.method) {
    case "initialize":
      result(request, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, _meta: { kiro: { replayMarking: true } } },
      });
      break;
    case "session/new": {
      if (catalog) {
        const initial = configOptions();
        if (earlyConfig) {
          modelsReady = true;
          update({ sessionUpdate: "config_option_update", configOptions: configOptions() });
        }
        result(request, { sessionId: sid, configOptions: initial });
        if (delayedConfig) {
          modelsReady = true;
          update({ sessionUpdate: "config_option_update", configOptions: configOptions() });
        }
        break;
      }
      const profile = await Bun.file(join(process.cwd(), ".kiro/agents", `${agent}.json`)).json();
      if (
        profile.prompt !== "Keep the asymmetric marker 719 in the system prompt." ||
        profile.permissions.rules[0].effect !== "allow" ||
        !process.argv.includes("v3") ||
        !process.argv.includes("--auth-method")
      ) {
        write({
          id: request.id,
          error: { code: -32602, message: "Incorrect v3 profile or launch" },
        });
        return;
      }
      const initial = configOptions();
      if (earlyConfig) {
        modelsReady = true;
        update({ sessionUpdate: "config_option_update", configOptions: configOptions() });
      }
      result(request, { sessionId: sid, configOptions: initial });
      break;
    }
    case "session/list":
      result(request, {
        sessions: [
          {
            sessionId: sid,
            cwd: process.cwd(),
            title: "Fixture",
            _meta: { kiro: { createdAt, source: "local" } },
          },
        ],
      });
      break;
    case "session/load":
      if (request.params?.sessionId !== sid) process.exit(22);
      result(request, {
        _meta: { id: sid, createdAt: process.env.KIRO_BAD_RESUME ? "wrong" : createdAt },
        configOptions: configOptions(),
      });
      break;
    case "session/set_config_option":
      if (request.params?.configId === "mode") configured = request.params.value === agent;
      if (request.params?.configId === "model") model = String(request.params.value);
      if (request.params?.configId === "effortLevel") effort = String(request.params.value);
      result(request, {
        configOptions:
          earlyConfig && request.params?.configId === "mode"
            ? configOptions().filter((option) => option.id === "mode")
            : configOptions(),
      });
      if (delayedConfig && request.params?.configId === "mode") {
        modelsReady = true;
        update({ sessionUpdate: "config_option_update", configOptions: configOptions() });
      }
      if (closedConfig && request.params?.configId === "mode") process.exit(0);
      break;
    case "session/prompt":
      if (!configured) {
        write({ id: request.id, error: { code: -32602, message: "Instructions not selected" } });
        return;
      }
      if (
        JSON.stringify(request.params).includes("require-model") &&
        (model !== "model-reasoning" || effort !== "high")
      ) {
        write({ id: request.id, error: { code: -32602, message: "Model not selected" } });
        return;
      }
      if (JSON.stringify(request.params).includes("disconnect-before-admission")) process.exit(23);
      if (active) replaced = active;
      active = request;
      if (JSON.stringify(request.params).includes("events")) {
        if (replaced) {
          result(replaced, { stopReason: "end_turn" });
          replaced = undefined;
        }
        update({
          sessionUpdate: "tool_call",
          toolCallId: "tool-1",
          title: "Run tests",
          name: "Bash",
          status: "in_progress",
          rawInput: { command: "bun test" },
        });
        update({
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          content: [{ type: "content", content: { type: "text", text: "tests passed" } }],
          status: "completed",
        });
        update({
          sessionUpdate: "session_info_update",
          _meta: { kiro: { kind: "error", message: "provider unavailable" } },
        });
        for (const permission of [
          {
            sessionId: sid,
            expected: "always",
            options: [
              { optionId: "always", name: "Always", kind: "allow_always" },
              { optionId: "once", name: "Once", kind: "allow_once" },
            ],
          },
          {
            sessionId: sid,
            expected: "once",
            options: [{ optionId: "once", name: "Once", kind: "allow_once" }],
          },
          {
            sessionId: "foreign",
            expected: undefined,
            options: [{ optionId: "once", name: "Once", kind: "allow_once" }],
          },
        ]) {
          const id = ++clientRequestId;
          permissionRequests.set(id, permission.expected);
          write({
            id,
            method: "session/request_permission",
            params: {
              sessionId: permission.sessionId,
              toolCall: { toolCallId: `permission-${id}` },
              options: permission.options,
            },
          });
        }
        break;
      }
      update({
        sessionUpdate: "session_info_update",
        _meta: {
          kiro: { kind: "user_message_id_assigned", userMessageId: `message-${++admissions}` },
        },
      });
      break;
    case "session/cancel":
      if (active) {
        if (JSON.stringify(active.params).includes("busy-old")) replaced = active;
        else result(active, { stopReason: "cancelled" });
        active = undefined;
      }
      break;
    case "fixture/late-old":
      if (replaced) result(replaced, { stopReason: "end_turn" });
      result(request, {});
      break;
    default:
      if (typeof request.id === "number" && permissionRequests.has(request.id)) {
        const expected = permissionRequests.get(request.id);
        const outcome = (request.result as { outcome?: { outcome?: string; optionId?: string } })
          ?.outcome;
        if (expected ? outcome?.optionId !== expected : outcome?.outcome !== "cancelled")
          process.exit(24);
        permissionRequests.delete(request.id);
        if (permissionRequests.size === 0)
          update({
            sessionUpdate: "session_info_update",
            _meta: {
              kiro: { kind: "user_message_id_assigned", userMessageId: `message-${++admissions}` },
            },
          });
      }
  }
}

for await (const line of console) {
  try {
    await handle(JSON.parse(line));
  } catch {
    process.exit(21);
  }
}
