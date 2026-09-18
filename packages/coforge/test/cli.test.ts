import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, resolveReminderId, run } from "../index";
import { CliError, renderCliErrorJson, renderCliErrorText } from "../src/cli-error";
import { validateTaskRequest } from "@lrm/coforge-sdk/internal";
import {
  createAgentApiClient,
  createAgentApiRawClient,
  createAgentApiSurfaceClient,
  workspaceInfoRoute,
} from "@lrm/coforge-sdk/agent";

test("Agent API client requests workspace info through its route contract", async () => {
  const calls: unknown[] = [];
  const client = createAgentApiClient({
    request: async (route) => {
      calls.push(route);
      return {
        ok: true,
        status: 200,
        data: {
          protocolMajor: 1,
          requestId: "r",
          workspace: { id: "w", name: "Acme", slug: "acme" },
          humans: [],
          agents: [],
          projects: [],
        },
      };
    },
  });

  await expect(client.workspace.info()).resolves.toMatchObject({ workspace: { slug: "acme" } });
  expect(calls).toEqual([workspaceInfoRoute]);
});

test("Agent API raw and surface clients preserve Raft-style error layering", async () => {
  const transport = {
    request: async () => ({ ok: false as const, status: 403, error: "workspace access denied" }),
  };
  await expect(createAgentApiRawClient(transport).workspace.info()).resolves.toEqual({
    ok: false,
    status: 403,
    error: "workspace access denied",
  });
  await expect(createAgentApiSurfaceClient(transport).workspace.info()).rejects.toThrow(
    "workspace access denied",
  );
});

test("workspace info parses validated sections and formats a mocked summary", async () => {
  expect(
    parseArgs([
      "workspace",
      "info",
      "--projects",
      "--query",
      "core",
      "--limit",
      "1",
      "--offset",
      "0",
    ]),
  ).toEqual({
    command: "workspace.info",
    projects: true,
    query: "core",
    limit: 1,
    offset: 0,
  });
  const output = await run(["workspace", "info", "--projects", "--query", "core"], {
    check: async () => ({ messages: [] }),
    read: async () => undefined,
    send: async () => undefined,
    view: async () => ({ bytes: new Uint8Array() }),
    workspaceInfo: async () => ({
      protocolMajor: 1,
      requestId: "r",
      workspace: { id: "w", name: "Acme", slug: "acme" },
      humans: [],
      agents: [],
      projects: [
        { id: "p", name: "Core", slug: "core", githubFullName: "acme/core", githubHtmlUrl: "" },
      ],
    }),
  });
  expect(output).toBe("Core (core) github=acme/core");
});

test("workspace info rejects invalid pagination and conflicting sections", () => {
  expect(() => parseArgs(["workspace", "info", "--limit", "0"])).toThrow("Usage:");
  expect(() => parseArgs(["workspace", "info", "--offset", "-1"])).toThrow("Usage:");
  expect(() => parseArgs(["workspace", "info", "--full", "--agents"])).toThrow("Usage:");
});

const FULL_RUNTIME_CONTEXT = {
  agentId: "agent-1",
  agentName: "scout",
  runtime: "codex",
  model: "gpt-5-codex",
  reasoning: "medium",
  workspaceId: "workspace-1",
  workspaceSlug: "acme",
  workspaceName: "Acme",
  computerId: "computer-1",
  computerName: "Builder Box",
  computerHostname: "workstation-7",
  computerOs: "darwin 15.6",
  computerVersion: "0.1.0-dev.40",
};
const WORKSPACE_INFO_BASE = {
  protocolMajor: 1,
  requestId: "r",
  workspace: { id: "w", name: "Acme", slug: "acme" },
  humans: [],
  agents: [],
  projects: [],
};

function withAgentWorkspacePathEnv<T>(value: string | undefined, run: () => Promise<T>) {
  const previous = Bun.env.COFORGE_CURRENT_AGENT_WORKSPACE_PATH;
  if (value === undefined) delete Bun.env.COFORGE_CURRENT_AGENT_WORKSPACE_PATH;
  else Bun.env.COFORGE_CURRENT_AGENT_WORKSPACE_PATH = value;
  return run().finally(() => {
    if (previous === undefined) delete Bun.env.COFORGE_CURRENT_AGENT_WORKSPACE_PATH;
    else Bun.env.COFORGE_CURRENT_AGENT_WORKSPACE_PATH = previous;
  });
}

test("workspace info default summary prints a Current Runtime block for a full runtimeContext", async () => {
  const output = await withAgentWorkspacePathEnv(undefined, () =>
    run(["workspace", "info"], {
      check: async () => ({ messages: [] }),
      read: async () => undefined,
      send: async () => undefined,
      view: async () => ({ bytes: new Uint8Array() }),
      workspaceInfo: async () => ({ ...WORKSPACE_INFO_BASE, runtimeContext: FULL_RUNTIME_CONTEXT }),
    }),
  );
  expect(output).toBe(
    [
      "### Current Runtime",
      "Authoritative context for this Agent process. Do not infer Computer identity from hostname or cwd when this section is present.",
      "- Agent: @scout (agent-1)",
      "- Provider: codex",
      "- Model: gpt-5-codex",
      "- Reasoning: medium",
      "- Workspace: Acme (acme)",
      "- Computer: Builder Box (computer-1)",
      "- Hostname: workstation-7",
      "- OS: darwin 15.6",
      "- Computer version: v0.1.0-dev.40",
      "",
      "Acme (acme)\nagents=0 humans=0 projects=0",
    ].join("\n"),
  );
});

test("workspace info default summary prints only the known bullets for a partial runtimeContext", async () => {
  const output = await withAgentWorkspacePathEnv(undefined, () =>
    run(["workspace", "info"], {
      check: async () => ({ messages: [] }),
      read: async () => undefined,
      send: async () => undefined,
      view: async () => ({ bytes: new Uint8Array() }),
      workspaceInfo: async () => ({
        ...WORKSPACE_INFO_BASE,
        runtimeContext: { agentName: "scout", runtime: "codex" },
      }),
    }),
  );
  expect(output).toBe(
    [
      "### Current Runtime",
      "Authoritative context for this Agent process. Do not infer Computer identity from hostname or cwd when this section is present.",
      "- Agent: @scout",
      "- Provider: codex",
      "",
      "Acme (acme)\nagents=0 humans=0 projects=0",
    ].join("\n"),
  );
});

test("workspace info default summary omits the Current Runtime block when nothing is known", async () => {
  const output = await withAgentWorkspacePathEnv(undefined, () =>
    run(["workspace", "info"], {
      check: async () => ({ messages: [] }),
      read: async () => undefined,
      send: async () => undefined,
      view: async () => ({ bytes: new Uint8Array() }),
      workspaceInfo: async () => WORKSPACE_INFO_BASE,
    }),
  );
  expect(output).toBe("Acme (acme)\nagents=0 humans=0 projects=0");
});

test("workspace info fills Agent workspace from the env var, both in the summary block and --full JSON", async () => {
  const transport = {
    check: async () => ({ messages: [] }),
    read: async () => undefined,
    send: async () => undefined,
    view: async () => ({ bytes: new Uint8Array() }),
    workspaceInfo: async () => ({ ...WORKSPACE_INFO_BASE, runtimeContext: { agentId: "agent-1" } }),
  };
  const summary = await withAgentWorkspacePathEnv("/home/agent/workspaces/w/agents/agent-1", () =>
    run(["workspace", "info"], transport),
  );
  expect(summary).toContain("- Agent workspace: /home/agent/workspaces/w/agents/agent-1");

  const full = await withAgentWorkspacePathEnv("/home/agent/workspaces/w/agents/agent-1", () =>
    run(["workspace", "info", "--full"], transport),
  );
  expect(JSON.parse(full as string).runtimeContext).toEqual({
    agentId: "agent-1",
    agentWorkspacePath: "/home/agent/workspaces/w/agents/agent-1",
  });
});

test("workspace info --full omits runtimeContext entirely when nothing is known", async () => {
  const full = await withAgentWorkspacePathEnv(undefined, () =>
    run(["workspace", "info", "--full"], {
      check: async () => ({ messages: [] }),
      read: async () => undefined,
      send: async () => undefined,
      view: async () => ({ bytes: new Uint8Array() }),
      workspaceInfo: async () => WORKSPACE_INFO_BASE,
    }),
  );
  expect(JSON.parse(full as string).runtimeContext).toBeUndefined();
});

const reminderId = "12345678-1234-4123-8123-123456789abc";

test("parses recurring reminders with an explicit default timezone and dispatches them", async () => {
  const invocation = parseArgs([
    "reminder",
    "schedule",
    "--title",
    "Daily standup",
    "--target",
    "@ada:abcdef12",
    "--message-id",
    "deadbeef",
    "--repeat",
    "daily@09:30",
  ]);
  expect(invocation).toEqual({
    command: "reminder",
    operation: "schedule",
    title: "Daily standup",
    target: "@ada:abcdef12",
    messageId: "deadbeef",
    repeat: "daily@09:30",
    timezone: "Asia/Shanghai",
  });
  const calls: unknown[] = [];
  const output = await run(
    [
      "reminder",
      "schedule",
      "--title",
      "Daily standup",
      "--target",
      "#general",
      "--message-id",
      "deadbeef",
      "--fire-at",
      "2026-09-09T09:30:00+08:00",
      "--repeat",
      "weekly:mon,fri@09:30",
      "--tz",
      "Asia/Shanghai",
    ],
    {
      check: async () => ({ messages: [] }),
      read: async () => undefined,
      send: async () => undefined,
      view: async () => ({ bytes: new Uint8Array() }),
      reminder: async (request) => {
        calls.push(request);
        return {
          protocolMajor: 1,
          requestId: "request",
          workspaceId: "workspace",
          computerId: "computer",
          agentId: "agent",
          accepted: true,
          reminders: [],
          events: [],
        };
      },
    },
  );
  expect(calls).toEqual([
    {
      operation: "schedule",
      title: "Daily standup",
      target: "#general",
      messageId: "deadbeef",
      fireAt: "2026-09-09T09:30:00+08:00",
      repeat: "weekly:mon,fri@09:30",
      timezone: "Asia/Shanghai",
    },
  ]);
  expect(output).toBe("Accepted reminder schedule request.");
});

test("rejects malformed and ambiguous reminder commands", () => {
  expect(() => parseArgs(["reminder", "cancel", "--id", "1234567"])).toThrow("full UUID");
  expect(() => parseArgs(["reminder", "list", "--all", "--status", "scheduled"])).toThrow("Usage:");
  expect(() =>
    parseArgs([
      "reminder",
      "snooze",
      "--id",
      reminderId,
      "--delay-seconds",
      "2",
      "--fire-at",
      "2026-09-09T00:00:00Z",
    ]),
  ).toThrow("Usage:");
  expect(() => parseArgs(["reminder", "schedule", "--title", "a", "--title", "b"])).toThrow(
    "Duplicate",
  );
  expect(() => parseArgs(["reminder", "log", "--wat", "x"])).toThrow("Unknown");
});

test("accepts a short hex id prefix, and the --by/--in duration and --cadence/--channel/--msg-id aliases", () => {
  expect(parseArgs(["reminder", "cancel", "--id", "12345678"])).toEqual({
    command: "reminder",
    operation: "cancel",
    reminderId: "12345678",
  });
  expect(parseArgs(["reminder", "snooze", "--id", reminderId, "--by", "5m"])).toEqual({
    command: "reminder",
    operation: "snooze",
    reminderId,
    delaySeconds: 300,
  });
  expect(parseArgs(["reminder", "update", "--id", reminderId, "--in", "10m"])).toEqual({
    command: "reminder",
    operation: "update",
    reminderId,
    delaySeconds: 600,
  });
  expect(
    parseArgs([
      "reminder",
      "schedule",
      "--title",
      "Standup",
      "--channel",
      "#general",
      "--msg-id",
      "deadbeef",
      "--delay-seconds",
      "30m",
    ]),
  ).toEqual({
    command: "reminder",
    operation: "schedule",
    title: "Standup",
    target: "#general",
    messageId: "deadbeef",
    delaySeconds: 1800,
  });
  expect(parseArgs(["reminder", "update", "--id", reminderId, "--cadence", "none"])).toEqual({
    command: "reminder",
    operation: "update",
    reminderId,
    repeat: "none",
  });
});

test("rejects a reminder alias combined with its canonical flag, and an invalid duration", () => {
  expect(() =>
    parseArgs(["reminder", "update", "--id", reminderId, "--repeat", "none", "--cadence", "none"]),
  ).toThrow("Cannot combine");
  expect(() =>
    parseArgs([
      "reminder",
      "schedule",
      "--title",
      "a",
      "--target",
      "#g",
      "--channel",
      "#g2",
      "--message-id",
      "deadbeef",
      "--delay-seconds",
      "5",
    ]),
  ).toThrow("Cannot combine");
  expect(() =>
    parseArgs([
      "reminder",
      "schedule",
      "--title",
      "a",
      "--target",
      "#g",
      "--message-id",
      "deadbeef",
      "--msg-id",
      "deadbee0",
      "--delay-seconds",
      "5",
    ]),
  ).toThrow("Cannot combine");
  expect(() =>
    parseArgs(["reminder", "snooze", "--id", reminderId, "--by", "notaduration"]),
  ).toThrow("Invalid duration");
  expect(() =>
    parseArgs(["reminder", "snooze", "--id", reminderId, "--by", "5m", "--delay-seconds", "5"]),
  ).toThrow("Cannot combine");
  expect(() =>
    parseArgs([
      "reminder",
      "update",
      "--id",
      reminderId,
      "--in",
      "5m",
      "--fire-at",
      "2026-09-09T00:00:00Z",
    ]),
  ).toThrow("Usage:");
  expect(() =>
    parseArgs(["reminder", "update", "--id", reminderId, "--in", "5m", "--delay-seconds", "300"]),
  ).toThrow("Cannot combine");
});

test("update requires exactly one mutation, and --tz only alongside a cadence change", () => {
  expect(() => parseArgs(["reminder", "update", "--id", reminderId])).toThrow(
    "Pass exactly one of --fire-at, --in, --cadence, or --title",
  );
  expect(() =>
    parseArgs(["reminder", "update", "--id", reminderId, "--title", "New", "--cadence", "none"]),
  ).toThrow("Pass exactly one of --fire-at, --in, --cadence, or --title");
  expect(() =>
    parseArgs(["reminder", "update", "--id", reminderId, "--title", "New", "--in", "5m"]),
  ).toThrow("Pass exactly one of --fire-at, --in, --cadence, or --title");
  expect(() =>
    parseArgs(["reminder", "update", "--id", reminderId, "--tz", "Asia/Shanghai"]),
  ).toThrow("Pass exactly one of --fire-at, --in, --cadence, or --title");
  expect(() =>
    parseArgs(["reminder", "update", "--id", reminderId, "--title", "New", "--tz", "UTC"]),
  ).toThrow("--tz may only accompany a cadence change");
  expect(() =>
    parseArgs(["reminder", "update", "--id", reminderId, "--in", "5m", "--tz", "UTC"]),
  ).toThrow("--tz may only accompany a cadence change");
  expect(
    parseArgs([
      "reminder",
      "update",
      "--id",
      reminderId,
      "--cadence",
      "daily@09:00",
      "--tz",
      "UTC",
    ]),
  ).toEqual({
    command: "reminder",
    operation: "update",
    reminderId,
    repeat: "daily@09:00",
    timezone: "UTC",
  });
  expect(parseArgs(["reminder", "update", "--id", reminderId, "--title", "New title"])).toEqual({
    command: "reminder",
    operation: "update",
    reminderId,
    title: "New title",
  });
});

test("list defaults to no explicit status filter, accepts a comma-separated status set, and still rejects --all with --status", () => {
  expect(parseArgs(["reminder", "list"])).toEqual({ command: "reminder", operation: "list" });
  expect(parseArgs(["reminder", "list", "--status", "scheduled,fired"])).toEqual({
    command: "reminder",
    operation: "list",
    status: "scheduled,fired",
  });
  expect(parseArgs(["reminder", "list", "--all"])).toEqual({
    command: "reminder",
    operation: "list",
    all: true,
  });
  expect(() => parseArgs(["reminder", "list", "--all", "--status", "scheduled,fired"])).toThrow(
    "Usage:",
  );
  expect(() => parseArgs(["reminder", "list", "--status", "scheduled,scheduled"])).toThrow(
    "invalid reminder status",
  );
  expect(() => parseArgs(["reminder", "list", "--status", "bogus"])).toThrow(
    "invalid reminder status",
  );
});

test("resolveReminderId matches a dash-stripped id prefix, and rejects zero or many matches", async () => {
  const first = {
    reminderId: "12345678-1234-4123-8123-123456789abc",
    ownerAgentId: "agent",
    version: 1,
    title: "First",
    target: "#g",
    messageId: "deadbeef",
    fireAt: "2026-09-09T00:00:00Z",
    status: "scheduled" as const,
    createdAt: "2026-09-08T00:00:00Z",
  };
  const second = {
    ...first,
    reminderId: "12345679-1234-4123-8123-123456789abc",
    title: "Second",
  };
  const scopeFields = {
    protocolMajor: 1,
    requestId: "r",
    workspaceId: "w",
    computerId: "c",
    agentId: "agent",
  };
  const calls: unknown[] = [];
  const listing = (reminders: (typeof first)[]) => ({
    reminder: async (request: unknown) => {
      calls.push(request);
      return { ...scopeFields, accepted: true, events: [], reminders };
    },
  });
  await expect(resolveReminderId(listing([first, second]), "123456781234")).resolves.toBe(
    first.reminderId,
  );
  expect(calls.at(-1)).toEqual({ operation: "list", all: true });
  await expect(resolveReminderId(listing([]), "ffffffff")).rejects.toMatchObject({
    code: "NOT_FOUND",
    message: "No reminder matches id prefix 'ffffffff'.",
  });
  const ambiguousFirst = { ...first, reminderId: "aaaaaaaa-1111-4111-8111-111111111111" };
  const ambiguousSecond = { ...first, reminderId: "aaaaaaaa-2222-4222-8222-222222222222" };
  await expect(
    resolveReminderId(listing([ambiguousFirst, ambiguousSecond]), "aaaaaaaa"),
  ).rejects.toMatchObject({
    code: "AMBIGUOUS",
    message: "Ambiguous id prefix 'aaaaaaaa' matches 2 reminders; pass a longer id.",
  });
});

test("resolveReminderId scopes the lookup to scheduled/fired for cancel/snooze, and names that scope in NOT_FOUND", async () => {
  const calls: unknown[] = [];
  const scopeFields = {
    protocolMajor: 1,
    requestId: "r",
    workspaceId: "w",
    computerId: "c",
    agentId: "agent",
  };
  const transport = {
    reminder: async (request: unknown) => {
      calls.push(request);
      return { ...scopeFields, accepted: true, events: [], reminders: [] };
    },
  };
  await expect(
    resolveReminderId(transport, "ffffffff", { statuses: ["scheduled", "fired"] }),
  ).rejects.toMatchObject({
    code: "NOT_FOUND",
    message: "No scheduled/fired reminder matches id prefix 'ffffffff'.",
  });
  expect(calls).toEqual([{ operation: "list", status: "scheduled,fired" }]);
});

test("run resolves a short --id prefix by listing reminders before dispatching the real request", async () => {
  const base = {
    check: async () => ({ messages: [] }),
    read: async () => undefined,
    send: async () => undefined,
    view: async () => ({ bytes: new Uint8Array() }),
  };
  const scopeFields = {
    protocolMajor: 1,
    requestId: "r",
    workspaceId: "w",
    computerId: "c",
    agentId: "agent",
  };
  const calls: unknown[] = [];
  const output = await run(["reminder", "cancel", "--id", "12345678"], {
    ...base,
    reminder: async (request) => {
      calls.push(request);
      if (request.operation === "list")
        return {
          ...scopeFields,
          accepted: true,
          events: [],
          reminders: [
            {
              reminderId,
              ownerAgentId: "agent",
              version: 3,
              title: "Deploy",
              target: "#release",
              messageId: "deadbeef",
              fireAt: "2026-09-09T01:00:00Z",
              status: "scheduled" as const,
              createdAt: "2026-09-08T01:00:00Z",
            },
          ],
        };
      return { ...scopeFields, accepted: true, events: [], reminders: [] };
    },
  });
  expect(calls).toEqual([
    { operation: "list", status: "scheduled,fired" },
    { operation: "cancel", reminderId },
  ]);
  expect(output).toBe("Accepted reminder cancel request.");
});

test("run resolves a short --id prefix unscoped (across every status) for update and log", async () => {
  const base = {
    check: async () => ({ messages: [] }),
    read: async () => undefined,
    send: async () => undefined,
    view: async () => ({ bytes: new Uint8Array() }),
  };
  const scopeFields = {
    protocolMajor: 1,
    requestId: "r",
    workspaceId: "w",
    computerId: "c",
    agentId: "agent",
  };
  const listResponse = {
    ...scopeFields,
    accepted: true,
    events: [],
    reminders: [
      {
        reminderId,
        ownerAgentId: "agent",
        version: 3,
        title: "Deploy",
        target: "#release",
        messageId: "deadbeef",
        fireAt: "2026-09-09T01:00:00Z",
        status: "scheduled" as const,
        createdAt: "2026-09-08T01:00:00Z",
      },
    ],
  };
  const updateCalls: unknown[] = [];
  await run(["reminder", "update", "--id", "12345678", "--title", "Renamed"], {
    ...base,
    reminder: async (request) => {
      updateCalls.push(request);
      if (request.operation === "list") return listResponse;
      return { ...scopeFields, accepted: true, events: [], reminders: [] };
    },
  });
  expect(updateCalls).toEqual([
    { operation: "list", all: true },
    { operation: "update", reminderId, title: "Renamed" },
  ]);

  const logCalls: unknown[] = [];
  await run(["reminder", "log", "--id", "12345678"], {
    ...base,
    reminder: async (request) => {
      logCalls.push(request);
      if (request.operation === "list") return listResponse;
      return { ...scopeFields, accepted: true, events: [], reminders: [] };
    },
  });
  expect(logCalls).toEqual([
    { operation: "list", all: true },
    { operation: "log", reminderId },
  ]);
});

test("run rejects a short --id prefix that matches no reminder or more than one", async () => {
  const base = {
    check: async () => ({ messages: [] }),
    read: async () => undefined,
    send: async () => undefined,
    view: async () => ({ bytes: new Uint8Array() }),
  };
  const scopeFields = {
    protocolMajor: 1,
    requestId: "r",
    workspaceId: "w",
    computerId: "c",
    agentId: "agent",
  };
  await expect(
    run(["reminder", "cancel", "--id", "ffffffff"], {
      ...base,
      reminder: async () => ({ ...scopeFields, accepted: true, events: [], reminders: [] }),
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  const ambiguousFields = {
    ownerAgentId: "agent",
    version: 1,
    title: "T",
    target: "#g",
    messageId: "deadbeef",
    fireAt: "2026-09-09T00:00:00Z",
    status: "scheduled" as const,
    createdAt: "2026-09-08T00:00:00Z",
  };
  await expect(
    run(["reminder", "cancel", "--id", "aaaaaaaa"], {
      ...base,
      reminder: async () => ({
        ...scopeFields,
        accepted: true,
        events: [],
        reminders: [
          { ...ambiguousFields, reminderId: "aaaaaaaa-1111-4111-8111-111111111111" },
          { ...ambiguousFields, reminderId: "aaaaaaaa-2222-4222-8222-222222222222" },
        ],
      }),
    }),
  ).rejects.toMatchObject({ code: "AMBIGUOUS" });
});

test("formats usable reminder lists, empty logs, and receipt acknowledgements", async () => {
  const base = {
    check: async () => ({ messages: [] }),
    read: async () => undefined,
    send: async () => undefined,
    view: async () => ({ bytes: new Uint8Array() }),
  };
  const output = await run(["reminder", "list", "--all"], {
    ...base,
    reminder: async () => ({
      protocolMajor: 1,
      requestId: "request",
      workspaceId: "workspace",
      computerId: "computer",
      agentId: "agent",
      accepted: true,
      events: [],
      reminders: [
        {
          reminderId,
          ownerAgentId: "agent",
          version: 3,
          title: "Deploy",
          target: "#release",
          messageId: "deadbeef",
          fireAt: "2026-09-09T01:00:00Z",
          status: "scheduled",
          repeat: "every:1d",
          timezone: "Asia/Shanghai",
          createdAt: "2026-09-08T01:00:00Z",
        },
      ],
    }),
  });
  expect(output).toContain(`id=${reminderId} revision=3 status=scheduled`);
  expect(output).toContain("anchor=deadbeef target=#release");
  expect(
    await run(["reminder", "log", "--id", reminderId], {
      ...base,
      reminder: async () => ({
        protocolMajor: 1,
        requestId: "request",
        workspaceId: "workspace",
        computerId: "computer",
        agentId: "agent",
        accepted: true,
        reminders: [],
        events: [],
      }),
    }),
  ).toBe("No reminder events found.");
  expect(
    await run(["reminder", "ack", "--id", reminderId, "--revision", "3"], {
      ...base,
      reminder: async () => ({ accepted: true, reminderId, revision: 3 }),
    }),
  ).toContain(`id=${reminderId} revision=3`);
});

test("Task commands require exact arguments and reject thread targets", () => {
  expect(
    parseArgs(["task", "claim", "--target", "#general", "--message-id", "message-1"]),
  ).toMatchObject({
    command: "task",
    task: { operation: "claim", target: "#general", messageId: "message-1" },
  });
  expect(parseArgs(["task", "list", "--target", "@ada", "--status", "todo"])).toMatchObject({
    command: "task",
    task: { operation: "list", target: "@ada", status: "todo" },
  });
  expect(
    parseArgs([
      "task",
      "create",
      "--target",
      "#general",
      "--title",
      "Ship it",
      "--assignee",
      "@ada",
    ]),
  ).toMatchObject({ task: { operation: "create", title: "Ship it", assignee: "@ada" } });
  expect(() => parseArgs(["task", "claim", "--target", "#general"])).toThrow("Usage:");
  expect(() => parseArgs(["task", "list", "--target", "#general:deadbeef"])).toThrow("Usage:");
  expect(() => parseArgs(["task", "delete", "--target", "#general"])).toThrow("Usage:");
});

test("Task command parsing covers Raft lifecycle actions and explicit description clearing", () => {
  expect(
    parseArgs(["task", "assign", "--target", "#general", "--number", "2", "--assignee", "@ada"]),
  ).toMatchObject({ task: { operation: "assign", number: 2, assignee: "@ada" } });
  expect(
    parseArgs(["task", "amend", "--target", "#general", "--number", "2", "--clear-description"]),
  ).toMatchObject({ task: { operation: "amend", number: 2, description: null } });
  for (const operation of ["history", "delete"] as const)
    expect(parseArgs(["task", operation, "--target", "#general", "--number", "2"])).toMatchObject({
      task: { operation, number: 2 },
    });
});

test("Task unassign dispatches its own protocol operation with no assignee", () => {
  expect(parseArgs(["task", "unassign", "--target", "#general", "--number", "2"])).toMatchObject({
    task: { operation: "unassign", number: 2, assignee: undefined },
  });
  expect(
    parseArgs([
      "task",
      "unassign",
      "--target",
      "#general",
      "--number",
      "2",
      "--expected-revision",
      "4",
    ]),
  ).toMatchObject({
    task: { operation: "unassign", number: 2, expectedRevision: 4 },
  });
  expect(() =>
    parseArgs(["task", "unassign", "--target", "#general", "--number", "2", "--assignee", "@ada"]),
  ).toThrow("Usage:");
  expect(() => parseArgs(["task", "unassign", "--target", "#general"])).toThrow("Usage:");
});

test("Task receipt forwards all seven fields through the backend contract", async () => {
  const receipt = {
    object: "bucket preview-719",
    purpose: "Review build artifacts",
    teardownOwner: "@ada",
    securityPrivacy: "Private; no credentials stored",
    expiry: "2030-03-04T05:06:00.000Z",
    runbook: "docs/cleanup.md",
    tracking: "#general:12345678",
  };
  const flags = [
    "--object",
    "--purpose",
    "--teardown-owner",
    "--security-privacy",
    "--expiry",
    "--runbook",
    "--tracking",
  ];
  const values = [
    receipt.object,
    receipt.purpose,
    receipt.teardownOwner,
    receipt.securityPrivacy,
    "2030-03-04T13:06:00+08:00",
    receipt.runbook,
    receipt.tracking,
  ];
  const base = ["task", "receipt", "--target", "#general", "--number", "7"];
  const calls: unknown[] = [];
  await run([...base, ...flags.flatMap((flag, index) => [flag, ` ${values[index]} `])], {
    check: async () => ({ messages: [] }),
    read: async () => ({}),
    send: async () => ({}),
    view: async () => ({ bytes: new Uint8Array() }),
    task: async (command) => {
      validateTaskRequest({
        ...command,
        protocolMajor: 1,
        workspaceId: "workspace",
        agentId: "agent",
      });
      calls.push(command);
      return { tasks: [] };
    },
  });
  expect(calls).toEqual([expect.objectContaining({ operation: "receipt", number: 7, receipt })]);
  for (const omitted of flags)
    expect(() =>
      parseArgs([
        ...base,
        ...flags.flatMap((flag, index) => (flag === omitted ? [] : [flag, values[index]!])),
      ]),
    ).toThrow();
});

test("Task amendment rejects conflicting description options before dispatch", async () => {
  for (const options of [
    ["--description", "Keep deployment instructions", "--clear-description"],
    ["--clear-description", "--description", "Keep deployment instructions"],
  ]) {
    const calls: unknown[] = [];
    await expect(
      run(["task", "amend", "--target", "#general", "--number", "7", ...options], {
        check: async () => ({ messages: [] }),
        read: async () => ({}),
        send: async () => ({}),
        view: async () => ({ bytes: new Uint8Array() }),
        task: async (command) => {
          calls.push(command);
          return { tasks: [] };
        },
      }),
    ).rejects.toThrow("Use either --description or --clear-description, not both");
    expect(calls).toEqual([]);
  }
});

test("Task update reads one revision then submits once and formats Thread-useful identity", async () => {
  const calls: any[] = [];
  const output = await run(
    ["task", "update", "--target", "#general", "--number", "2", "--status", "in_review"],
    {
      check: async () => ({ messages: [] }),
      read: async () => ({}),
      send: async () => ({}),
      view: async () => ({ bytes: new Uint8Array() }),
      task: async (command) => {
        calls.push(command);
        return {
          tasks: [
            {
              messageId: "message-2",
              conversationId: "conversation",
              number: 2,
              title: "Verify",
              status: command.operation === "update" ? "in_review" : "in_progress",
              revision: 5,
              owner: { memberId: "member", kind: "agent", name: "builder" },
            },
          ],
        };
      },
    },
  );
  expect(calls).toHaveLength(2);
  expect(calls[1]).toMatchObject({ operation: "update", expectedRevision: 5 });
  expect(output).toContain("#2 status=in_review owner=builder message=message-2");
});

test("Task unclaim reads one revision unless explicitly supplied and submits once", async () => {
  for (const args of [
    ["task", "unclaim", "--target", "#general", "--number", "2"],
    ["task", "unclaim", "--target", "#general", "--number", "2", "--expected-revision", "4"],
  ]) {
    const calls: any[] = [];
    await run(args, {
      check: async () => ({ messages: [] }),
      read: async () => ({}),
      send: async () => ({}),
      view: async () => ({ bytes: new Uint8Array() }),
      task: async (command) => {
        calls.push(command);
        return {
          tasks: [
            {
              messageId: "message-2",
              conversationId: "conversation",
              number: 2,
              title: "Verify",
              status: "in_progress",
              revision: 4,
              owner: { memberId: "member", kind: "agent", name: "builder" },
            },
          ],
        };
      },
    });
    expect(calls.at(-1)).toMatchObject({ operation: "unclaim", expectedRevision: 4 });
    expect(calls).toHaveLength(args.includes("--expected-revision") ? 1 : 2);
  }
});

test("Task unassign submits its own protocol operation with no assignee", async () => {
  const calls: any[] = [];
  const output = await run(["task", "unassign", "--target", "#general", "--number", "2"], {
    check: async () => ({ messages: [] }),
    read: async () => ({}),
    send: async () => ({}),
    view: async () => ({ bytes: new Uint8Array() }),
    task: async (command) => {
      calls.push(command);
      return {
        tasks: [
          {
            messageId: "message-2",
            conversationId: "conversation",
            number: 2,
            title: "Verify",
            status: "in_progress",
            revision: 4,
            owner: null,
          },
        ],
      };
    },
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ operation: "unassign", number: 2, assignee: undefined });
  expect(output).toContain("#2 status=in_progress owner=unclaimed message=message-2");
});

test("Agent channel mute and unmute change its own setting without sending a message", async () => {
  const calls: unknown[] = [];
  for (const command of ["mute", "unmute"] as const) {
    expect(parseArgs(["channel", command, "--target", "#general"])).toEqual({
      command,
      target: "#general",
    });
    await run(["channel", command, "--target", "#general"], {
      check: async () => {
        throw new Error("unexpected check");
      },
      read: async () => {
        throw new Error("unexpected read");
      },
      send: async () => {
        throw new Error("unexpected send");
      },
      view: async () => {
        throw new Error("unexpected view");
      },
      setChannelMuted: async (target, muted) => {
        calls.push([target, muted]);
        return { accepted: true };
      },
    });
  }
  expect(calls).toEqual([
    ["#general", true],
    ["#general", false],
  ]);
  expect(() => parseArgs(["channel", "mute", "--target", "@alice"])).toThrow("Usage:");
  expect(() => parseArgs(["channel", "mute", "--target", "#general:12345678"])).toThrow("Usage:");
});

test("channel management commands parse into a channel operation and dispatch through the transport", async () => {
  expect(parseArgs(["channel", "info", "#engineering"])).toEqual({
    command: "channel-manage",
    channel: { operation: "info", target: "#engineering" },
  });
  expect(parseArgs(["channel", "members", "#engineering"])).toEqual({
    command: "channel-manage",
    channel: { operation: "members", target: "#engineering" },
  });
  expect(parseArgs(["channel", "join", "--target", "#engineering"])).toEqual({
    command: "channel-manage",
    channel: { operation: "join", target: "#engineering" },
    json: false,
  });
  expect(parseArgs(["channel", "leave", "--target", "#engineering", "--json"])).toEqual({
    command: "channel-manage",
    channel: { operation: "leave", target: "#engineering" },
    json: true,
  });
  expect(parseArgs(["channel", "create", "--name", "engineering"])).toEqual({
    command: "channel-manage",
    channel: { operation: "create", name: "engineering", description: undefined },
    json: false,
  });
  expect(
    parseArgs(["channel", "create", "--name", "engineering", "--description", "Eng team"]),
  ).toEqual({
    command: "channel-manage",
    channel: { operation: "create", name: "engineering", description: "Eng team" },
    json: false,
  });
  expect(
    parseArgs(["channel", "update", "--target", "#engineering", "--description", "Eng team"]),
  ).toEqual({
    command: "channel-manage",
    channel: {
      operation: "update",
      target: "#engineering",
      name: undefined,
      description: "Eng team",
    },
    json: false,
  });
  expect(parseArgs(["channel", "lifecycle", "archive", "--target", "#engineering"])).toEqual({
    command: "channel-manage",
    channel: { operation: "archive", target: "#engineering" },
    json: false,
  });
  expect(parseArgs(["channel", "lifecycle", "unarchive", "--target", "#engineering"])).toEqual({
    command: "channel-manage",
    channel: { operation: "unarchive", target: "#engineering" },
    json: false,
  });
  expect(
    parseArgs(["channel", "add-member", "--target", "#engineering", "--user", "@alice"]),
  ).toEqual({
    command: "channel-manage",
    channel: { operation: "add-member", target: "#engineering", user: "@alice", agent: undefined },
    json: false,
  });
  expect(
    parseArgs(["channel", "remove-member", "--target", "#engineering", "--agent", "@reviewer"]),
  ).toEqual({
    command: "channel-manage",
    channel: {
      operation: "remove-member",
      target: "#engineering",
      user: undefined,
      agent: "@reviewer",
    },
    json: false,
  });

  const calls: unknown[] = [];
  const result = await run(["channel", "join", "--target", "#engineering"], {
    check: async () => {
      throw new Error("unexpected check");
    },
    read: async () => {
      throw new Error("unexpected read");
    },
    send: async () => {
      throw new Error("unexpected send");
    },
    view: async () => {
      throw new Error("unexpected view");
    },
    channel: async (command) => {
      calls.push(command);
      return {
        protocolMajor: 1,
        requestId: "r-1",
        target: "#engineering",
        joined: true,
        alreadyJoined: false,
      };
    },
  });
  expect(calls).toEqual([{ operation: "join", target: "#engineering" }]);
  expect(result).toBe(
    [
      "Joined #engineering. You can now send messages there and receive ordinary channel delivery.",
      "Still arrives:",
      "- Personal @mentions still reach you even if you later mute ordinary channel updates.",
      "- Threads you started or follow stay followed even if you later mute this channel.",
    ].join("\n"),
  );
});

test("channel join/leave/update/lifecycle/add-member/remove-member reject a non-regular target", () => {
  for (const args of [
    ["channel", "join", "--target", "@alice"],
    ["channel", "leave", "--target", "#general:12345678"],
    ["channel", "update", "--target", "general", "--description", "x"],
    ["channel", "lifecycle", "archive", "--target", "@alice"],
    ["channel", "add-member", "--target", "@alice", "--user", "@bob"],
    ["channel", "remove-member", "--target", "thread-123", "--user", "@bob"],
  ]) {
    try {
      parseArgs(args);
      throw new Error(`expected a CliError for ${args.join(" ")}`);
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).code).toBe("INVALID_TARGET");
      expect((error as CliError).message).toBe(
        "Target must be a regular channel in the form '#channel-name'. DMs and thread targets are not supported.",
      );
    }
  }
  // info/members accept a wider target grammar (thread targets, @user) and are unaffected.
  expect(parseArgs(["channel", "info", "@alice"])).toEqual({
    command: "channel-manage",
    channel: { operation: "info", target: "@alice" },
  });
  expect(parseArgs(["channel", "members", "#general:12345678"])).toEqual({
    command: "channel-manage",
    channel: { operation: "members", target: "#general:12345678" },
  });
});

test("channel management commands reject malformed arguments and require exactly one of --user/--agent", () => {
  expect(() => parseArgs(["channel", "info"])).toThrow("Usage:");
  expect(() => parseArgs(["channel", "info", "#a", "extra"])).toThrow("Usage:");
  expect(() => parseArgs(["channel", "join"])).toThrow("Usage:");
  expect(() => parseArgs(["channel", "create"])).toThrow("Usage:");
  expect(() => parseArgs(["channel", "update", "--target", "#a"])).toThrow("Usage:");
  expect(() => parseArgs(["channel", "lifecycle", "delete", "--target", "#a"])).toThrow("Usage:");
  expect(() => parseArgs(["channel", "add-member", "--target", "#a"])).toThrow("Usage:");
  expect(() =>
    parseArgs(["channel", "add-member", "--target", "#a", "--user", "@x", "--agent", "@y"]),
  ).toThrow("Usage:");
  expect(() => parseArgs(["channel", "bogus-operation", "--target", "#a"])).toThrow("Usage:");
});

test("--private and --public are rejected as unsupported, not silently ignored", () => {
  expect(() => parseArgs(["channel", "create", "--name", "eng", "--private"])).toThrow(
    "private channels are not supported in CoForge",
  );
  try {
    parseArgs(["channel", "create", "--name", "eng", "--private"]);
    throw new Error("expected a CliError");
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe("UNSUPPORTED");
  }
  expect(() => parseArgs(["channel", "update", "--target", "#eng", "--public"])).toThrow(
    "private channels are not supported in CoForge",
  );
});

test("channel management --json prints the raw response for every subcommand", async () => {
  const rawResponse = { protocolMajor: 1, requestId: "r-2", target: "#eng", archived: true };
  const result = await run(["channel", "lifecycle", "archive", "--target", "#eng", "--json"], {
    check: async () => ({ messages: [] }),
    read: async () => undefined,
    send: async () => undefined,
    view: async () => ({ bytes: new Uint8Array() }),
    channel: async () => rawResponse,
  });
  expect(result).toBe(rawResponse);
});

test("Agent thread unfollow changes only the exact channel thread", async () => {
  const calls: unknown[] = [];
  expect(parseArgs(["thread", "unfollow", "--target", "#general:12345678"])).toEqual({
    command: "thread-unfollow",
    target: "#general:12345678",
  });
  await run(["thread", "unfollow", "--target", "#general:12345678"], {
    check: async () => ({ messages: [] }),
    read: async () => undefined,
    send: async () => undefined,
    view: async () => ({ bytes: new Uint8Array() }),
    setThreadFollowed: async (target, followed) => {
      calls.push([target, followed]);
      return { accepted: true };
    },
  });
  expect(calls).toEqual([["#general:12345678", false]]);
  expect(() => parseArgs(["thread", "unfollow", "--target", "#general"])).toThrow("Usage:");
  expect(() => parseArgs(["thread", "unfollow", "--target", "@alice:12345678"])).toThrow("Usage:");
});

test("message check has no target arguments", () => {
  expect(parseArgs(["message", "check"])).toEqual({ command: "check" });
  expect(() => parseArgs(["message", "check", "--target", "@ada"])).toThrow("Usage:");
});

test("message search aligns with Raft lexical search options and dispatches them", async () => {
  expect(
    parseArgs([
      "message",
      "search",
      "--query",
      "release plan",
      "--target",
      "#general",
      "--sender",
      "@ada",
      "--sort",
      "recent",
      "--before",
      "2026-09-07T12:00:00Z",
      "--limit",
      "10",
      "--offset",
      "2",
    ]),
  ).toEqual({
    command: "search",
    query: "release plan",
    target: "#general",
    sender: "@ada",
    sort: "recent",
    before: "2026-09-07T12:00:00Z",
    limit: 10,
    offset: 2,
  });
  const calls: unknown[] = [];
  const output = await run(["message", "search", "--query", "release", "--limit", "5"], {
    check: async () => ({ messages: [] }),
    read: async () => undefined,
    search: async (options) => {
      calls.push(options);
      return {
        messages: [
          {
            id: "aaaaaaaa-0000-4000-8000-000000000001",
            sequence: 99,
            sender: "@ada",
            target: "#general",
            body: "release plan",
            createdAt: "2026-09-07T10:00:00Z",
          },
        ],
      };
    },
    send: async () => undefined,
    view: async () => ({ bytes: new Uint8Array() }),
  });
  expect(calls).toEqual([{ query: "release", limit: 5 }]);
  expect(output).toContain('Search results for: "release" (1 result)');
  expect(output).toContain('<result ref="msg:aaaaaaaa-0000-4000-8000-000000000001">');
  expect(output).toContain("Source: #general");
  expect(output).toContain("Time: 2026-09-07 10:00:00Z");
  expect(output).toContain("<match>release</match> plan");
  expect(output).not.toContain("sequence");
});

test("message search rejects empty searches and invalid Raft options", () => {
  expect(() => parseArgs(["message", "search"])).toThrow("Usage:");
  expect(() => parseArgs(["message", "search", "--query", "x", "--sort", "oldest"])).toThrow(
    "Usage:",
  );
  expect(() => parseArgs(["message", "search", "--query", "x", "--offset", "-1"])).toThrow(
    "Usage:",
  );
});

test.each(["read", "send"] as const)("requires an explicit target for message %s", (command) => {
  expect(() => parseArgs(["message", command])).toThrow("Usage:");
  expect(parseArgs(["message", command, "--target", "@ada"])).toEqual({
    command,
    target: "@ada",
  });
});

test("message resolve looks up one message by id and formats it like message check", async () => {
  expect(parseArgs(["message", "resolve", "abcd1234"])).toEqual({
    command: "resolve",
    messageId: "abcd1234",
  });
  const calls: string[] = [];
  const output = await run(["message", "resolve", "abcd1234"], {
    check: async () => ({ messages: [] }),
    read: async () => undefined,
    send: async () => undefined,
    view: async () => ({ bytes: new Uint8Array() }),
    resolve: async (messageId) => {
      calls.push(messageId);
      return {
        messages: [
          {
            id: "abcd1234-0000-4000-8000-000000000001",
            sequence: 1,
            sender: "@ada",
            target: "#general",
            body: "release plan",
            createdAt: "2026-09-07T10:00:00Z",
          },
        ],
      };
    },
  });
  expect(calls).toEqual(["abcd1234"]);
  expect(output).toBe(
    "[target=#general msg=abcd1234 time=2026-09-07 10:00:00Z] @ada: release plan",
  );
});

test("message resolve reports a clear error when the message is not found", async () => {
  await expect(
    run(["message", "resolve", "abcd1234"], {
      check: async () => ({ messages: [] }),
      read: async () => undefined,
      send: async () => undefined,
      view: async () => ({ bytes: new Uint8Array() }),
      resolve: async () => ({ messages: [] }),
    }),
  ).rejects.toThrow("message not found or not visible to this Agent");
});

test("message resolve rejects malformed argument shapes", () => {
  expect(() => parseArgs(["message", "resolve"])).toThrow("Usage:");
  expect(() => parseArgs(["message", "resolve", "abcd1234", "extra"])).toThrow("Usage:");
});

test.each([
  [false, "added to"],
  [true, "removed from"],
] as const)(
  "message react parses flags in any order and dispatches with remove=%s",
  async (remove, verb) => {
    const flags = remove
      ? ["--emoji", "👍", "--remove", "--message-id", "abcd1234"]
      : ["--message-id", "abcd1234", "--emoji", "👍"];
    expect(parseArgs(["message", "react", ...flags])).toEqual({
      command: "react",
      messageId: "abcd1234",
      emoji: "👍",
      ...(remove ? { remove: true } : {}),
    });
    const calls: unknown[] = [];
    const output = await run(["message", "react", ...flags], {
      check: async () => ({ messages: [] }),
      read: async () => undefined,
      send: async () => undefined,
      view: async () => ({ bytes: new Uint8Array() }),
      react: async (messageId, emoji, removeArg) => {
        calls.push([messageId, emoji, removeArg === true]);
        return { accepted: true };
      },
    });
    expect(calls).toEqual([["abcd1234", "👍", remove]]);
    expect(output).toBe(`Reaction 👍 ${verb} message abcd1234.`);
  },
);

test("message react rejects bad ids, missing emoji, whitespace emoji, and --remove without --emoji", () => {
  // bad id
  expect(() => parseArgs(["message", "react", "--message-id", "not-hex", "--emoji", "👍"])).toThrow(
    "Usage:",
  );
  // missing emoji
  expect(() => parseArgs(["message", "react", "--message-id", "abcd1234"])).toThrow("Usage:");
  // whitespace emoji
  expect(() =>
    parseArgs(["message", "react", "--message-id", "abcd1234", "--emoji", "a b"]),
  ).toThrow("Usage:");
  // --remove without --emoji
  expect(() => parseArgs(["message", "react", "--message-id", "abcd1234", "--remove"])).toThrow(
    "Usage:",
  );
});

test("message resolve rejects an emoji-shaped or malformed id", () => {
  expect(() => parseArgs(["message", "resolve", "not-hex"])).toThrow("Usage:");
  expect(() => parseArgs(["message", "resolve", "abcd123"])).toThrow("Usage:");
});

test("App Inbox exposes check without a generic acknowledgement command", () => {
  expect(parseArgs(["inbox", "check"])).toEqual({ command: "inbox-check" });
  expect(() => parseArgs(["inbox", "ack", "--item", "reminder:id:1"])).toThrow("Usage:");
});

test("dispatches Inbox check without message operations", async () => {
  const calls: string[] = [];
  const transport = {
    check: async () => {
      throw new Error("message check called");
    },
    read: async () => {
      throw new Error("message read called");
    },
    send: async () => {
      throw new Error("message send called");
    },
    view: async () => {
      throw new Error("attachment called");
    },
    inboxCheck: async () => calls.push("check"),
  };
  await run(["inbox", "check"], transport);
  expect(calls).toEqual(["check"]);
});

test("parses attachment view with an output path", () => {
  expect(
    parseArgs(["attachment", "view", "--id", "attachment-1", "--output", "/tmp/file.txt"]),
  ).toEqual({
    command: "attachment.view",
    attachmentId: "attachment-1",
    output: "/tmp/file.txt",
  });
});

test("parses attachment view with a positional id, Raft-style", () => {
  expect(parseArgs(["attachment", "view", "attachment-1", "--output", "/tmp/file.txt"])).toEqual({
    command: "attachment.view",
    attachmentId: "attachment-1",
    output: "/tmp/file.txt",
  });
});

test("parses attachment view --json", () => {
  expect(
    parseArgs(["attachment", "view", "attachment-1", "--output", "/tmp/file.txt", "--json"]),
  ).toEqual({
    command: "attachment.view",
    attachmentId: "attachment-1",
    output: "/tmp/file.txt",
    json: true,
  });
});

test("attachment view rejects both a positional id and --id, matching Raft's validateViewOpts", () => {
  expect(() =>
    parseArgs(["attachment", "view", "attachment-1", "--id", "attachment-2", "--output", "/tmp/f"]),
  ).toThrow(CliError);
  try {
    parseArgs(["attachment", "view", "attachment-1", "--id", "attachment-2", "--output", "/tmp/f"]);
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe("INVALID_ARG");
    expect((error as CliError).message).toBe(
      "pass the attachment id either positionally or with --id, not both",
    );
  }
});

test("attachment view rejects a missing id with Raft's exact code and message", () => {
  expect(() => parseArgs(["attachment", "view", "--output", "/tmp/file.txt"])).toThrow(CliError);
  try {
    parseArgs(["attachment", "view", "--output", "/tmp/file.txt"]);
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe("INVALID_ARG");
    expect((error as CliError).message).toBe(
      "attachment id is required (pass <attachmentId> or --id)",
    );
  }
});

test("attachment view rejects a missing --output with Raft's exact code and message", () => {
  expect(() => parseArgs(["attachment", "view", "attachment-1"])).toThrow(CliError);
  try {
    parseArgs(["attachment", "view", "attachment-1"]);
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe("INVALID_ARG");
    expect((error as CliError).message).toBe("--output is required");
  }
});

test("dispatches attachment view and prints Raft's exact download-destination line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coforge-cli-"));
  const output = join(dir, "downloaded.txt");
  try {
    const result = await run(["attachment", "view", "attachment-1", "--output", output], {
      check: async () => {
        throw new Error("unused");
      },
      read: async () => {
        throw new Error("unused");
      },
      send: async () => {
        throw new Error("unused");
      },
      view: async () => ({ bytes: new TextEncoder().encode("hello") }),
    });
    expect(result).toBe(`Downloaded to: ${output}`);
    expect(await Bun.file(output).text()).toBe("hello");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("attachment view --json prints the attachment id and output path as an object", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coforge-cli-"));
  const output = join(dir, "downloaded.txt");
  try {
    const result = await run(["attachment", "view", "attachment-1", "--output", output, "--json"], {
      check: async () => {
        throw new Error("unused");
      },
      read: async () => {
        throw new Error("unused");
      },
      send: async () => {
        throw new Error("unused");
      },
      view: async () => ({ bytes: new TextEncoder().encode("hello") }),
    });
    expect(JSON.parse(result as string)).toEqual({ attachmentId: "attachment-1", path: output });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parses attachment upload with target, mime type, and --json", () => {
  expect(
    parseArgs(["attachment", "upload", "--path", "/tmp/file.txt", "--target", "@ada"]),
  ).toEqual({
    command: "attachment.upload",
    path: "/tmp/file.txt",
    target: "@ada",
    mimeType: undefined,
  });
  expect(
    parseArgs([
      "attachment",
      "upload",
      "--path",
      "/tmp/file.txt",
      "--target",
      "@ada",
      "--mime-type",
      "image/png",
      "--json",
    ]),
  ).toEqual({
    command: "attachment.upload",
    path: "/tmp/file.txt",
    target: "@ada",
    mimeType: "image/png",
    json: true,
  });
});

test("parses attachment upload's legacy --channel alias for --target", () => {
  expect(
    parseArgs(["attachment", "upload", "--path", "/tmp/file.txt", "--channel", "#general"]),
  ).toEqual({
    command: "attachment.upload",
    path: "/tmp/file.txt",
    target: "#general",
    mimeType: undefined,
  });
});

test("rejects attachment upload given both --target and --channel, even when equal", () => {
  expect(() =>
    parseArgs([
      "attachment",
      "upload",
      "--path",
      "/tmp/file.txt",
      "--target",
      "@ada",
      "--channel",
      "@ada",
    ]),
  ).toThrow("Usage:");
  expect(() =>
    parseArgs([
      "attachment",
      "upload",
      "--path",
      "/tmp/file.txt",
      "--target",
      "@ada",
      "--channel",
      "#other",
    ]),
  ).toThrow("Usage:");
});

test("dispatches attachment upload through the injected transport with an inferred mime type", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coforge-cli-"));
  const path = join(dir, "note.txt");
  await writeFile(path, "hello");
  try {
    const calls: unknown[] = [];
    const result = await run(["attachment", "upload", "--path", path, "--target", "@ada"], {
      check: async () => {
        throw new Error("unused");
      },
      read: async () => {
        throw new Error("unused");
      },
      send: async () => {
        throw new Error("unused");
      },
      view: async () => {
        throw new Error("unused");
      },
      upload: async (input) => {
        calls.push(input);
        return {
          id: "attachment-1",
          fileName: "note.txt",
          contentType: "text/plain",
          sizeBytes: 5,
        };
      },
    });
    expect(calls).toEqual([{ path, target: "@ada", mimeType: "text/plain" }]);
    expect(result).toBe(
      "File uploaded: note.txt (0.0KB)\n" +
        "Attachment ID: attachment-1\n\n" +
        "Use this ID with coforge message send --attachment-id attachment-1 to include it in a message.",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("attachment upload --json prints the raw response object", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coforge-cli-"));
  const path = join(dir, "image.png");
  await writeFile(path, "fake-png-bytes");
  try {
    const result = await run(
      ["attachment", "upload", "--path", path, "--target", "#general", "--json"],
      {
        check: async () => {
          throw new Error("unused");
        },
        read: async () => {
          throw new Error("unused");
        },
        send: async () => {
          throw new Error("unused");
        },
        view: async () => {
          throw new Error("unused");
        },
        upload: async () => ({
          id: "attachment-1",
          fileName: "image.png",
          contentType: "image/png",
          sizeBytes: 14,
        }),
      },
    );
    expect(JSON.parse(result as string)).toEqual({
      id: "attachment-1",
      fileName: "image.png",
      contentType: "image/png",
      sizeBytes: 14,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("attachment upload rejects local preconditions before any transport call", async () => {
  const transport = {
    check: async () => {
      throw new Error("unused");
    },
    read: async () => {
      throw new Error("unused");
    },
    send: async () => {
      throw new Error("unused");
    },
    view: async () => {
      throw new Error("unused");
    },
    upload: async () => {
      throw new Error("must not upload: a local precondition failed");
    },
  };
  await expect(run(["attachment", "upload", "--target", "@ada"], transport)).rejects.toMatchObject({
    code: "INVALID_ARG",
    message: "--path is required",
  });
  await expect(
    run(
      ["attachment", "upload", "--path", "/tmp/coforge-does-not-exist.bin", "--target", "@ada"],
      transport,
    ),
  ).rejects.toMatchObject({ code: "INVALID_ARG" });

  const dir = await mkdtemp(join(tmpdir(), "coforge-cli-"));
  try {
    const emptyPath = join(dir, "empty.txt");
    await writeFile(emptyPath, "");
    await expect(
      run(["attachment", "upload", "--path", emptyPath, "--target", "@ada"], transport),
    ).rejects.toMatchObject({
      code: "INVALID_ARG",
      message: "--path is empty; refusing to upload a 0-byte attachment",
    });
    await expect(
      run(["attachment", "upload", "--path", dir, "--target", "@ada"], transport),
    ).rejects.toMatchObject({ code: "INVALID_ARG" });

    const filePath = join(dir, "note.txt");
    await writeFile(filePath, "hello");
    await expect(
      run(
        [
          "attachment",
          "upload",
          "--path",
          filePath,
          "--target",
          "@ada",
          "--mime-type",
          "not-a-mime-type",
        ],
        transport,
      ),
    ).rejects.toMatchObject({
      code: "INVALID_ARG",
      message: "--mime-type must look like type/subtype, got: not-a-mime-type",
    });
    // Missing --target surfaces after the path checks, as Raft's MISSING_CHANNEL, and wins
    // over a bad --mime-type since the target check runs first.
    await expect(
      run(
        ["attachment", "upload", "--path", filePath, "--mime-type", "not-a-mime-type"],
        transport,
      ),
    ).rejects.toMatchObject({
      code: "MISSING_CHANNEL",
      message:
        "A target is required to attach the upload to. Pass --target '#name', '@user', or a thread target.",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects agent-internal arguments", () => {
  expect(() => parseArgs(["message", "send", "agent-1"])).toThrow("Usage:");
});

test("parses a held draft retry", () => {
  expect(() => parseArgs(["message", "send", "--send-draft"])).toThrow("Usage:");
  expect(parseArgs(["message", "send", "--send-draft", "--anyway", "--target", "@ada"])).toEqual({
    command: "send",
    target: "@ada",
    sendDraft: true,
    continueAnyway: true,
  });
  expect(() => parseArgs(["message", "send", "--anyway", "--target", "@ada"])).toThrow("Usage:");
});

test("dispatches only through the injected transport seam", async () => {
  const calls: string[] = [];
  await expect(
    run(["message", "read", "--target", "@ada"], {
      check: async () => {
        throw new Error("unused");
      },
      read: async (target) => {
        calls.push(`read:${target}`);
        throw new Error("injected transport failure");
      },
      send: async () => {
        throw new Error("unused");
      },
      view: async () => {
        throw new Error("unused");
      },
    }),
  ).rejects.toThrow("injected transport failure");
  expect(calls).toEqual(["read:@ada"]);
});

test("message check hides server ordering fields", async () => {
  const output = await run(["message", "check"], {
    check: async () => ({
      accepted: true,
      messages: [
        {
          id: "message-7",
          sequence: 7,
          sender: "@ada",
          target: "@ada",
          body: "Can you investigate?",
          createdAt: "2026-09-03T10:00:00Z",
          attachments: [],
        },
      ],
    }),
    read: async () => undefined,
    send: async () => undefined,
    view: async () => ({ bytes: new Uint8Array() }),
  });

  expect(output).toBe(
    "[target=@ada msg=message- time=2026-09-03 10:00:00Z] @ada: Can you investigate?\n\nNo more new messages.",
  );
});

test("message check tells the Agent to run check again when the server reports more remain", async () => {
  const output = await run(["message", "check"], {
    check: async () => ({
      accepted: true,
      hasMore: true,
      messages: [
        {
          id: "message-7",
          sequence: 7,
          sender: "@ada",
          target: "@ada",
          body: "Can you investigate?",
          createdAt: "2026-09-03T10:00:00Z",
          attachments: [],
        },
      ],
    }),
    read: async () => undefined,
    send: async () => undefined,
    view: async () => ({ bytes: new Uint8Array() }),
  });

  expect(output).toBe(
    "[target=@ada msg=message- time=2026-09-03 10:00:00Z] @ada: Can you investigate?\n\nMore messages are pending. Run `coforge message check` again.",
  );
});

test("thread target and short parent range anchor pass through without a separate root option", async () => {
  const calls: unknown[] = [];
  const transport = {
    check: async () => ({ messages: [] }),
    read: async (target: string, options: unknown) => {
      calls.push({ target, options });
      return {};
    },
    send: async () => undefined,
    view: async () => ({ bytes: new Uint8Array() }),
  };
  await run(
    ["message", "read", "--target", "@alice:12345678", "--before", "87654321", "--limit", "10"],
    transport,
  );
  expect(calls[0]).toMatchObject({
    target: "@alice:12345678",
    options: { before: "87654321", limit: 10 },
  });
  expect(() =>
    parseArgs(["message", "read", "--target", "@alice", "--root", "12345678"]),
  ).toThrow();
});

test("message check says plainly when there are no pending messages", async () => {
  const output = await run(["message", "check"], {
    check: async () => ({ accepted: true, messages: [] }),
    read: async () => undefined,
    send: async () => undefined,
    view: async () => ({ bytes: new Uint8Array() }),
  });

  expect(output).toBe("No new messages.");
});

test("message read hides server ordering fields", async () => {
  const output = await run(["message", "read", "--target", "@ada"], {
    check: async () => ({ messages: [] }),
    read: async () => ({
      messages: [
        {
          id: "message-1",
          sequence: 42,
          sender: "@ada",
          target: "@ada",
          body: "hello",
          createdAt: "2026-09-03T10:00:00Z",
        },
      ],
      hasOlder: false,
      hasNewer: false,
    }),
    send: async () => undefined,
    view: async () => ({ bytes: new Uint8Array() }),
  });

  expect(output).not.toContain("sequence");
  expect(output).toContain("msg=message-1");
  expect(output).toContain("replyTarget=@ada:message-");
});

test("App Inbox hides message ordering fields from Agent output", async () => {
  const output = await run(["inbox", "check"], {
    check: async () => ({ messages: [] }),
    read: async () => undefined,
    send: async () => undefined,
    view: async () => ({ bytes: new Uint8Array() }),
    inboxCheck: async () => ({
      entries: [
        {
          kind: "message_target",
          messageTarget: {
            target: "@ada",
            pendingCount: 2,
            firstPendingSequence: 7,
            latestSequence: 8,
            flags: ["dm"],
          },
        },
      ],
    }),
  });

  expect(output).not.toContain("firstPendingSequence");
  expect(output).not.toContain("latestSequence");
  expect(output).toContain('"pendingCount":2');
});

test("--reviewer-isolation is accepted only on send, claim, update and amend", () => {
  expect(parseArgs(["message", "send", "--target", "@ada", "--reviewer-isolation"])).toMatchObject({
    command: "send",
    freshnessContextMode: "withheld",
  });
  expect(
    parseArgs(["task", "claim", "--target", "#general", "--number", "1", "--reviewer-isolation"]),
  ).toMatchObject({ task: { operation: "claim", freshnessContextMode: "withheld" } });
  expect(
    parseArgs([
      "task",
      "update",
      "--target",
      "#general",
      "--number",
      "1",
      "--status",
      "in_review",
      "--expected-revision",
      "5",
      "--reviewer-isolation",
    ]),
  ).toMatchObject({ task: { operation: "update", freshnessContextMode: "withheld" } });
  expect(
    parseArgs([
      "task",
      "amend",
      "--target",
      "#general",
      "--number",
      "1",
      "--title",
      "Ship it",
      "--reviewer-isolation",
    ]),
  ).toMatchObject({ task: { operation: "amend", freshnessContextMode: "withheld" } });
  expect(() => parseArgs(["task", "list", "--target", "#general", "--reviewer-isolation"])).toThrow(
    "Usage:",
  );
  expect(() =>
    parseArgs(["task", "unclaim", "--target", "#general", "--number", "1", "--reviewer-isolation"]),
  ).toThrow("Usage:");
  expect(() => parseArgs(["message", "read", "--target", "@ada", "--reviewer-isolation"])).toThrow(
    "Usage:",
  );
});

test("COFORGE_REVIEWER_ISOLATION environment variable enables reviewer isolation without the flag", () => {
  const previous = process.env.COFORGE_REVIEWER_ISOLATION;
  try {
    process.env.COFORGE_REVIEWER_ISOLATION = "1";
    expect(parseArgs(["message", "send", "--target", "@ada"])).toMatchObject({
      freshnessContextMode: "withheld",
    });
    expect(parseArgs(["task", "claim", "--target", "#general", "--number", "1"])).toMatchObject({
      task: { freshnessContextMode: "withheld" },
    });
    process.env.COFORGE_REVIEWER_ISOLATION = "not-a-boolean";
    expect(() => parseArgs(["message", "send", "--target", "@ada"])).toThrow(
      "COFORGE_REVIEWER_ISOLATION must be one of: 1, true, 0, false",
    );
  } finally {
    if (previous === undefined) delete process.env.COFORGE_REVIEWER_ISOLATION;
    else process.env.COFORGE_REVIEWER_ISOLATION = previous;
  }
});

test("reviewer-isolation held Task output suppresses secret context", async () => {
  const output = await run(
    ["task", "claim", "--target", "#general", "--number", "1", "--reviewer-isolation"],
    {
      check: async () => ({ messages: [] }),
      read: async () => undefined,
      send: async () => undefined,
      view: async () => ({ bytes: new Uint8Array() }),
      task: async () => ({
        tasks: [],
        state: "held",
        freshnessContextMode: "withheld",
        newMessageCount: 2,
        heldMessages: [
          {
            id: "secret-id",
            sequence: 1,
            sender: "secret-sender",
            target: "#secret",
            body: "SECRET_SENTINEL",
            createdAt: "now",
            attachments: [],
          },
        ],
      }),
    },
  );
  expect(output).toBe("Reviewer-isolation freshness hold: 2 newer messages withheld.");
  expect(output).not.toContain("SECRET_SENTINEL");
});

test("requested reviewer isolation suppresses held Task context even when the response says inline", async () => {
  const output = await run(
    [
      "task",
      "update",
      "--target",
      "#general",
      "--number",
      "1",
      "--status",
      "in_review",
      "--expected-revision",
      "5",
      "--reviewer-isolation",
    ],
    {
      check: async () => ({ messages: [] }),
      read: async () => undefined,
      send: async () => undefined,
      view: async () => ({ bytes: new Uint8Array() }),
      task: async () => ({
        tasks: [],
        state: "held",
        freshnessContextMode: "inline",
        newMessageCount: 1,
        heldMessages: [
          {
            id: "secret-id",
            sequence: 1,
            sender: "secret-sender",
            target: "#secret",
            body: "SECRET_SENTINEL",
            createdAt: "now",
            attachments: [],
          },
        ],
      }),
    },
  );
  expect(output).toBe("Reviewer-isolation freshness hold: 1 newer message withheld.");
  expect(output).not.toContain("SECRET_SENTINEL");
});

test("non-reviewer-isolation Task holds still surface the held messages", async () => {
  const output = await run(
    [
      "task",
      "update",
      "--target",
      "#general",
      "--number",
      "1",
      "--status",
      "in_review",
      "--expected-revision",
      "5",
    ],
    {
      check: async () => ({ messages: [] }),
      read: async () => undefined,
      send: async () => undefined,
      view: async () => ({ bytes: new Uint8Array() }),
      task: async () => ({
        tasks: [],
        state: "held",
        heldMessages: [
          {
            id: "visible-id",
            sequence: 1,
            sender: "@ada",
            target: "#general",
            body: "VISIBLE_CONTEXT",
            createdAt: "now",
            attachments: [],
          },
        ],
      }),
    },
  );
  expect(output).toContain("Task request held.");
  expect(output).toContain("VISIBLE_CONTEXT");
});

test("reviewer-isolation Task transport failures redact upstream detail", async () => {
  await expect(
    run(
      [
        "task",
        "update",
        "--target",
        "#general",
        "--number",
        "1",
        "--status",
        "in_review",
        "--expected-revision",
        "5",
        "--reviewer-isolation",
      ],
      {
        check: async () => ({ messages: [] }),
        read: async () => undefined,
        send: async () => undefined,
        view: async () => ({ bytes: new Uint8Array() }),
        task: async () => {
          throw new Error("SECRET_UPSTREAM_DETAIL");
        },
      },
    ),
  ).rejects.toThrow("Reviewer-isolation Task request failed; upstream detail was withheld");
});

test("reviewer-isolation send redacts transport failures and held context", async () => {
  const transportFailure = await run(
    ["message", "send", "--target", "@ada", "--send-draft", "--reviewer-isolation"],
    {
      check: async () => ({ messages: [] }),
      read: async () => undefined,
      send: async () => {
        throw new Error("SECRET_UPSTREAM_DETAIL");
      },
      view: async () => ({ bytes: new Uint8Array() }),
    },
  ).catch((error: unknown) => error);
  expect(transportFailure).toBeInstanceOf(CliError);
  expect((transportFailure as CliError).message).toBe(
    "Reviewer-isolation send failed; upstream response detail was withheld.",
  );
  expect((transportFailure as CliError).draftSaved).toBe(true);
  expect((transportFailure as CliError).retryable).toBe(false);
  expect(renderCliErrorText(transportFailure as CliError)).not.toContain("SECRET_UPSTREAM_DETAIL");

  const held = await run(
    ["message", "send", "--target", "@ada", "--send-draft", "--reviewer-isolation"],
    {
      check: async () => ({ messages: [] }),
      read: async () => undefined,
      send: async () => ({
        accepted: false,
        sideEffectDecision: "hold",
        freshnessContextMode: "inline",
        newMessageCount: 2,
        messages: [{ body: "SECRET_HELD_DETAIL" }],
      }),
      view: async () => ({ bytes: new Uint8Array() }),
    },
  ).catch((error: unknown) => error);
  expect(held).toBeInstanceOf(CliError);
  expect((held as CliError).message).toBe(
    "Reviewer-isolation freshness hold: 2 newer messages withheld.",
  );
  expect((held as CliError).code).toBe("SEND_HELD_AS_DRAFT");
  expect(renderCliErrorText(held as CliError)).not.toContain("SECRET_HELD_DETAIL");
});

test("held sends fail with a typed error that keeps the existing held-context report", async () => {
  const error = await run(["message", "send", "--target", "@ada"], {
    check: async () => ({ messages: [] }),
    read: async () => undefined,
    send: async () => ({
      accepted: false,
      sideEffectDecision: "hold",
      attentionCount: 1,
      messages: [
        {
          id: "message-2",
          sequence: 9,
          sender: "@ada",
          target: "@ada",
          body: "new context",
          createdAt: "2026-09-03T10:05:00Z",
        },
      ],
    }),
    view: async () => ({ bytes: new Uint8Array() }),
  }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(CliError);
  const held = error as CliError;
  expect(held.code).toBe("SEND_HELD_AS_DRAFT");
  expect(held.message).toBe("Message held as draft; no target delivery occurred.");
  expect(held.draftSaved).toBe(true);
  expect(held.retryable).toBe(false);
  const rendered = renderCliErrorText(held);
  expect(rendered).toContain("saved as a draft");
  expect(rendered).toContain("Error: Message held as draft; no target delivery occurred.");
  expect(rendered).toContain("Code: SEND_HELD_AS_DRAFT");
  expect(rendered).toContain("Draft saved: yes");
  expect(rendered).toContain(
    "Next action: Review the held context, then update the draft or send the current draft unchanged.",
  );
});

test("message send --json renders a held failure as one JSON object", async () => {
  const error = await run(["message", "send", "--target", "@ada", "--send-draft", "--json"], {
    check: async () => ({ messages: [] }),
    read: async () => undefined,
    send: async () => ({
      accepted: false,
      sideEffectDecision: "hold",
      attentionCount: 0,
      messages: [],
    }),
    view: async () => ({ bytes: new Uint8Array() }),
  }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(CliError);
  const held = error as CliError;
  expect(held.outputMode).toBe("json");
  const parsed = JSON.parse(renderCliErrorJson(held));
  expect(parsed.error.code).toBe("SEND_HELD_AS_DRAFT");
  expect(parsed.error.draft_saved).toBe(true);
  expect(parsed.error.retryable).toBe(false);
});

test("send results hide the internal model cursor from Agent output", async () => {
  const output = await run(["message", "send", "--target", "@ada", "--send-draft"], {
    check: async () => ({ messages: [] }),
    read: async () => undefined,
    send: async () => ({
      accepted: true,
      messageId: "message-sent",
      seenUpToSequence: 9,
      messages: [],
    }),
    view: async () => ({ bytes: new Uint8Array() }),
  });

  expect(output).toBe(
    'Message sent to @ada. Message ID: message-sent (to reply in this message\'s thread, use target "@ada:message-")',
  );
  expect(output).not.toContain("seenUpToSequence");
});

test("weekly-report CLI parses bounded reads and dispatches the transport", async () => {
  const invocation = parseArgs([
    "weekly-report",
    "read",
    "--report-id",
    "33333333-3333-4333-8333-333333333333",
    "--section",
    "Progress",
    "--max-characters",
    "120",
  ]);
  expect(invocation).toEqual({
    command: "weekly-report",
    weeklyReport: {
      operation: "read",
      reportId: "33333333-3333-4333-8333-333333333333",
      section: "Progress",
      maxCharacters: 120,
    },
  });
  const calls: unknown[] = [];
  const output = await run(["weekly-report", "list", "--limit", "2"], {
    check: async () => {
      throw new Error("message check called");
    },
    read: async () => {
      throw new Error("message read called");
    },
    send: async () => {
      throw new Error("message send called");
    },
    view: async () => {
      throw new Error("attachment called");
    },
    weeklyReport: async (command) => {
      calls.push(command);
      return {
        protocolMajor: 1,
        requestId: "request",
        operation: "list",
        result: { reports: [], nextCursor: null },
      };
    },
  });
  expect(calls).toEqual([{ operation: "list", limit: 2 }]);
  expect(output).toEqual({
    protocolMajor: 1,
    requestId: "request",
    operation: "list",
    result: { reports: [], nextCursor: null },
  });
});

test("weekly-report CLI rejects oversized list limits", () => {
  expect(() => parseArgs(["weekly-report", "list", "--limit", "51"])).toThrow("Usage:");
});

test("message send --json reports a sent message as one JSON object", async () => {
  const output = await run(["message", "send", "--target", "@ada", "--send-draft", "--json"], {
    check: async () => ({ messages: [] }),
    read: async () => undefined,
    send: async () => ({ accepted: true, messageId: "message-1" }),
    view: async () => ({ bytes: new Uint8Array() }),
  });
  expect(JSON.parse(output as string)).toEqual({
    state: "sent",
    target: "@ada",
    messageId: "message-1",
    recentUnread: [],
  });
});

test("message send --json appends recentUnread from a bypass send", async () => {
  const output = await run(["message", "send", "--target", "@ada", "--send-draft", "--json"], {
    check: async () => ({ messages: [] }),
    read: async () => undefined,
    send: async () => ({
      accepted: true,
      messageId: "message-1",
      recentUnread: [
        {
          id: "message-2",
          sequence: 5,
          sender: "@ada",
          target: "@ada",
          body: "missed while you were held",
          createdAt: "2026-09-17T10:00:00Z",
        },
      ],
    }),
    view: async () => ({ bytes: new Uint8Array() }),
  });
  const parsed = JSON.parse(output as string);
  expect(parsed.recentUnread).toHaveLength(1);
  expect(parsed.recentUnread[0].body).toBe("missed while you were held");
});

test("message send text mode appends a recentUnread section after the sent line", async () => {
  const output = await run(["message", "send", "--target", "@ada", "--send-draft"], {
    check: async () => ({ messages: [] }),
    read: async () => undefined,
    send: async () => ({
      accepted: true,
      messageId: "message-1",
      recentUnread: [
        {
          id: "message-2",
          sequence: 5,
          sender: "@frank",
          target: "@ada",
          body: "missed while you were held",
          createdAt: "2026-09-17T10:00:00Z",
        },
      ],
    }),
    view: async () => ({ bytes: new Uint8Array() }),
  });
  expect(output).toContain("Message sent to @ada.");
  expect(output).toContain("--- New messages you may have missed ---");
  expect(output).toContain("missed while you were held");
});

test("message send parses --attachment-id, --mention, and --target-confirmed", () => {
  const invocation = parseArgs([
    "message",
    "send",
    "--target",
    "@ada",
    "--attachment-id",
    "11111111-1111-4111-8111-111111111111",
    "--mention",
    "human:22222222-2222-4222-8222-222222222222:ada",
    "--target-confirmed",
  ]);
  expect(invocation).toMatchObject({
    command: "send",
    target: "@ada",
    attachmentIds: ["11111111-1111-4111-8111-111111111111"],
    mentions: [{ type: "user", id: "22222222-2222-4222-8222-222222222222", name: "ada" }],
    targetConfirmed: true,
  });
});

test("message send accepts repeated --attachment-id occurrences, in order, uncapped", () => {
  const invocation = parseArgs([
    "message",
    "send",
    "--target",
    "@ada",
    "--attachment-id",
    "11111111-1111-4111-8111-111111111111",
    "--attachment-id",
    "22222222-2222-4222-8222-222222222222",
    "--attachment-id",
    "33333333-3333-4333-8333-333333333333",
  ]);
  expect(invocation).toMatchObject({
    command: "send",
    target: "@ada",
    attachmentIds: [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ],
  });
});

test("message send collapses a duplicate --attachment-id value to one occurrence", () => {
  const invocation = parseArgs([
    "message",
    "send",
    "--target",
    "@ada",
    "--attachment-id",
    "11111111-1111-4111-8111-111111111111",
    "--attachment-id",
    "11111111-1111-4111-8111-111111111111",
  ]);
  expect(invocation).toMatchObject({
    command: "send",
    target: "@ada",
    attachmentIds: ["11111111-1111-4111-8111-111111111111"],
  });
});

test("message send rejects a non-uuid --attachment-id with a typed usage error", () => {
  const error = (() => {
    try {
      parseArgs(["message", "send", "--target", "@ada", "--attachment-id", "abc"]);
      return undefined;
    } catch (caught) {
      return caught;
    }
  })();
  expect(error).toBeInstanceOf(CliError);
  const cliError = error as CliError;
  expect(cliError.code).toBe("INVALID_ARG");
  expect(cliError.message).toBe("--attachment-id must be a full attachment UUID.");
  expect(cliError.draftSaved).toBe(false);
});

test("message send --json reports a non-uuid --attachment-id as structured JSON", () => {
  const error = (() => {
    try {
      parseArgs(["message", "send", "--target", "@ada", "--attachment-id", "abc", "--json"]);
      return undefined;
    } catch (caught) {
      return caught;
    }
  })();
  expect(error).toBeInstanceOf(CliError);
  expect((error as CliError).outputMode).toBe("json");
  const parsed = JSON.parse(renderCliErrorJson(error as CliError));
  expect(parsed.error.code).toBe("INVALID_ARG");
  expect(parsed.error.draft_saved).toBe(false);
});

test("--attachment-id combined with --send-draft is a typed usage error", () => {
  const error = (() => {
    try {
      parseArgs([
        "message",
        "send",
        "--target",
        "@ada",
        "--send-draft",
        "--attachment-id",
        "11111111-1111-4111-8111-111111111111",
      ]);
      return undefined;
    } catch (caught) {
      return caught;
    }
  })();
  expect(error).toBeInstanceOf(CliError);
  const cliError = error as CliError;
  expect(cliError.code).toBe("INVALID_ARG");
  expect(cliError.message).toBe(
    "--attachment-id cannot be used with --send-draft. Use a normal send to replace the draft.",
  );
  expect(cliError.draftSaved).toBe(false);
});

test("an invalid --mention selector is a typed usage error", () => {
  const error = (() => {
    try {
      parseArgs(["message", "send", "--target", "@ada", "--send-draft", "--mention", "not-valid"]);
      return undefined;
    } catch (caught) {
      return caught;
    }
  })();
  expect(error).toBeInstanceOf(CliError);
  expect((error as CliError).code).toBe("INVALID_MENTION_SELECTOR");
  expect((error as CliError).draftSaved).toBe(false);
});

test("two --mention flags binding the same handle to different actors conflict", () => {
  const error = (() => {
    try {
      parseArgs([
        "message",
        "send",
        "--target",
        "@ada",
        "--send-draft",
        "--mention",
        "human:11111111-1111-4111-8111-111111111111:ada",
        "--mention",
        "agent:22222222-2222-4222-8222-222222222222:ada",
      ]);
      return undefined;
    } catch (caught) {
      return caught;
    }
  })();
  expect(error).toBeInstanceOf(CliError);
  const cliError = error as CliError;
  expect(cliError.code).toBe("MENTION_BINDING_CONFLICT");
  expect(cliError.message).toBe("@ada cannot be bound to more than one actor in the same message.");
});

test("message send forwards mentions and targetConfirmed to the transport on --send-draft", async () => {
  const calls: unknown[] = [];
  await run(["message", "send", "--target", "@ada", "--send-draft", "--target-confirmed"], {
    check: async () => ({ messages: [] }),
    read: async () => undefined,
    send: async (target, body, options) => {
      calls.push({ target, body, options });
      return { accepted: true, messageId: "message-1" };
    },
    view: async () => ({ bytes: new Uint8Array() }),
  });
  expect(calls).toEqual([
    {
      target: "@ada",
      body: undefined,
      options: {
        sendDraft: true,
        continueAnyway: undefined,
        freshnessContextMode: undefined,
        attachmentIds: undefined,
        mentions: undefined,
        targetConfirmed: true,
      },
    },
  ]);
});

test("manual get parses topic, --intent and --reason and dispatches to the transport", async () => {
  const validIntent = "Open a pull request for a bound repository";
  const validReason = "Confirm the exact clone and push commands to use";
  expect(
    parseArgs(["manual", "get", "github", "--intent", validIntent, "--reason", validReason]),
  ).toEqual({
    command: "manual-get",
    topic: "github",
    intent: validIntent,
    reason: validReason,
  });
  const calls: unknown[] = [];
  const output = await run(
    ["manual", "get", "github", "--intent", validIntent, "--reason", validReason],
    {
      check: async () => ({ messages: [] }),
      read: async () => undefined,
      send: async () => undefined,
      view: async () => ({ bytes: new Uint8Array() }),
      manualGet: async (topic, intent, reason) => {
        calls.push({ topic, intent, reason });
        return {
          ok: true,
          docId: "github",
          topicOrPath: "github",
          docVersion: "abc123",
          docState: "published",
          contentType: "text/markdown",
          content: "# GitHub\n\nClone it.",
        };
      },
    },
  );
  expect(calls).toEqual([{ topic: "github", intent: validIntent, reason: validReason }]);
  // Content is verbatim; the entry point's console.log supplies the single trailing newline.
  expect(output).toBe("# GitHub\n\nClone it.");
});

test("manual search parses keywords, --intent and --reason and formats numbered results", async () => {
  const validIntent = "Open a pull request for a bound repository";
  const validReason = "Confirm the exact clone and push commands to use";
  expect(
    parseArgs([
      "manual",
      "search",
      "github pull request",
      "--intent",
      validIntent,
      "--reason",
      validReason,
    ]),
  ).toEqual({
    command: "manual-search",
    query: "github pull request",
    intent: validIntent,
    reason: validReason,
  });
  const output = await run(
    ["manual", "search", "github pull request", "--intent", validIntent, "--reason", validReason],
    {
      check: async () => ({ messages: [] }),
      read: async () => undefined,
      send: async () => undefined,
      view: async () => ({ bytes: new Uint8Array() }),
      manualSearch: async () => ({
        ok: true,
        query: "github pull request",
        scope: null,
        results: [
          {
            slug: "github",
            title: "Working with GitHub",
            firstScreen: "Clone a repo.\nOpen a PR.",
          },
        ],
      }),
    },
  );
  expect(output).toBe("1. github — Working with GitHub\n   Clone a repo.\n   Open a PR.");
});

test("manual rejects a missing topic/keywords argument", () => {
  expect(() =>
    parseArgs(["manual", "get", "--intent", "x".repeat(20), "--reason", "y".repeat(20)]),
  ).toThrow();
  expect(() => parseArgs(["manual", "search"])).toThrow();
});

test("manual client-side validates --intent/--reason (12-500 chars, trimmed) before sending", () => {
  const long = "x".repeat(20);
  // Missing both.
  expect(() => parseArgs(["manual", "get", "github"])).toThrow(CliError);
  try {
    parseArgs(["manual", "get", "github"]);
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe("KNOWLEDGE_INTENT_INVALID");
    expect((error as CliError).message).toContain("--intent");
    expect((error as CliError).message).toContain("--reason");
  }
  // Reason too short.
  try {
    parseArgs(["manual", "get", "github", "--intent", long, "--reason", "short"]);
    throw new Error("expected a CliError");
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe("KNOWLEDGE_REASON_INVALID");
  }
  // Both present and long enough: no throw.
  expect(() =>
    parseArgs(["manual", "get", "github", "--intent", long, "--reason", long]),
  ).not.toThrow();
});

test("manual get surfaces a knowledge_not_found CliError with the Raft-aligned browse-index guidance", async () => {
  const validIntent = "Open a pull request for a bound repository";
  const validReason = "Confirm the exact clone and push commands to use";
  try {
    await run(
      ["manual", "get", "does-not-exist", "--intent", validIntent, "--reason", validReason],
      {
        check: async () => ({ messages: [] }),
        read: async () => undefined,
        send: async () => undefined,
        view: async () => ({ bytes: new Uint8Array() }),
        manualGet: async () => {
          throw new CliError({
            code: "knowledge_not_found",
            message: 'No Manual topic "does-not-exist".',
            retryable: false,
            suggestedNextAction: "Retry with a close topic id or different keywords",
          });
        },
      },
    );
    throw new Error("expected a CliError");
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe("knowledge_not_found");
    expect(renderCliErrorText(error as CliError)).toContain("Next action:");
  }
});

test("manual accepts flags before the positional and trims every value", () => {
  const intent = "Clone the project repository";
  const reason = "Need the documented git workflow";
  expect(
    parseArgs(["manual", "search", "--intent", ` ${intent} `, "--reason", reason, " clone repo "]),
  ).toEqual({ command: "manual-search", query: "clone repo", intent, reason });
  expect(() =>
    parseArgs(["manual", "get", "github", "extra", "--intent", intent, "--reason", reason]),
  ).toThrow();
});

const WHOAMI_ENV_KEYS = [
  "COFORGE_CURRENT_AGENT_ID",
  "COFORGE_CURRENT_AGENT_NAME",
  "COFORGE_CURRENT_WORKSPACE_ID",
  "COFORGE_CURRENT_WORKSPACE_SLUG",
  "COFORGE_CURRENT_WORKSPACE_NAME",
  "COFORGE_CURRENT_COMPUTER_ID",
  "COFORGE_CURRENT_COMPUTER_NAME",
  "COFORGE_CURRENT_COMPUTER_HOSTNAME",
  "COFORGE_CURRENT_AGENT_WORKSPACE_PATH",
  "COFORGE_AGENT_PROXY_URL",
  "COFORGE_AGENT_CONTEXT",
] as const;

/** Sets (or deletes, for `undefined`) every whoami-relevant env var for the duration of `run`,
 * restoring each previous value afterward — same pattern as `withAgentWorkspacePathEnv` above,
 * generalized to the whole set `coforge whoami` reads. */
function withWhoamiEnv<T>(
  values: Partial<Record<(typeof WHOAMI_ENV_KEYS)[number], string>>,
  run: () => T,
): T {
  const previous = Object.fromEntries(WHOAMI_ENV_KEYS.map((key) => [key, Bun.env[key]])) as Record<
    (typeof WHOAMI_ENV_KEYS)[number],
    string | undefined
  >;
  for (const key of WHOAMI_ENV_KEYS) {
    const value = values[key];
    if (value === undefined) delete Bun.env[key];
    else Bun.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const key of WHOAMI_ENV_KEYS) {
      if (previous[key] === undefined) delete Bun.env[key];
      else Bun.env[key] = previous[key];
    }
  }
}

const MINIMAL_TRANSPORT = {
  check: async () => ({ messages: [] }),
  read: async () => undefined,
  send: async () => undefined,
  view: async () => ({ bytes: new Uint8Array() }),
};

test("whoami rejects an unknown flag", () => {
  expect(() => parseArgs(["whoami", "--bogus"])).toThrow("Usage:");
});

test("whoami is deliberately local: it reports every known Runtime Context env var and redacts the token to its fixed prefix", async () => {
  const output = await withWhoamiEnv(
    {
      COFORGE_CURRENT_AGENT_ID: "agent-1",
      COFORGE_CURRENT_AGENT_NAME: "scout",
      COFORGE_CURRENT_WORKSPACE_ID: "workspace-1",
      COFORGE_CURRENT_WORKSPACE_SLUG: "acme",
      COFORGE_CURRENT_WORKSPACE_NAME: "Acme",
      COFORGE_CURRENT_COMPUTER_ID: "computer-1",
      COFORGE_CURRENT_COMPUTER_NAME: "Builder Box",
      COFORGE_CURRENT_COMPUTER_HOSTNAME: "workstation-7",
      COFORGE_CURRENT_AGENT_WORKSPACE_PATH: "/home/agent/workspace",
      COFORGE_AGENT_PROXY_URL: "http://127.0.0.1:4123/api/agent/v1/messages",
      COFORGE_AGENT_CONTEXT: "sfp_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
    },
    () => run(["whoami"], MINIMAL_TRANSPORT),
  );
  expect(output).toBe(
    [
      "## Who am I",
      "",
      "Agent ID: agent-1",
      "Agent name: @scout",
      "Workspace ID: workspace-1",
      "Workspace slug: acme",
      "Workspace name: Acme",
      "Computer ID: computer-1",
      "Computer name: Builder Box",
      "Computer hostname: workstation-7",
      "Agent workspace: /home/agent/workspace",
      "Agent proxy: http://127.0.0.1:4123/api/agent/v1/messages",
      "Client mode: daemon-managed",
      "Credential: source=agent-context-env present=yes redacted=sfp_…",
    ].join("\n"),
  );
});

test("whoami with an empty environment omits every unset bullet and reports no credential", async () => {
  const output = await withWhoamiEnv({}, () => run(["whoami"], MINIMAL_TRANSPORT));
  expect(output).toBe(
    ["## Who am I", "", "Client mode: daemon-managed", "Credential: source=none present=no"].join(
      "\n",
    ),
  );
});

test("whoami --json emits { ok: true, data } and never the token value, only its 4-character prefix", async () => {
  const output = await withWhoamiEnv(
    { COFORGE_AGENT_CONTEXT: "sfp_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG" },
    () => run(["whoami", "--json"], MINIMAL_TRANSPORT),
  );
  const parsed = JSON.parse(output as string);
  expect(parsed).toEqual({
    ok: true,
    data: {
      clientMode: "daemon-managed",
      credential: { source: "agent-context-env", present: true, redacted: "sfp_…" },
    },
  });
  expect(JSON.stringify(parsed)).not.toContain("abcdefghijklmnopqrstuvwxyz");
});

test("whoami never calls the transport: it is local by design", async () => {
  const calls: string[] = [];
  await withWhoamiEnv({}, () =>
    run(["whoami"], {
      ...MINIMAL_TRANSPORT,
      check: async () => {
        calls.push("check");
        return { messages: [] };
      },
    }),
  );
  expect(calls).toEqual([]);
});

test("version rejects an unknown flag", () => {
  expect(() => parseArgs(["version", "--bogus"])).toThrow("Usage:");
});

test("version parses --json", () => {
  expect(parseArgs(["version"])).toEqual({ command: "version" });
  expect(parseArgs(["version", "--json"])).toEqual({ command: "version", json: true });
});

test("version queries the live daemon and prints CLI/Daemon/Computer lines", async () => {
  const output = await run(["version"], {
    ...MINIMAL_TRANSPORT,
    version: async () => ({
      ok: true,
      daemonVersion: "0.1.0-dev.38",
      computerVersion: "0.1.0-dev.38",
    }),
  });
  expect(output).toMatch(/^CLI: \S+\nDaemon: 0\.1\.0-dev\.38\nComputer: 0\.1\.0-dev\.38$/);
});

test("version omits the Computer line when the live daemon does not report one", async () => {
  const output = await run(["version"], {
    ...MINIMAL_TRANSPORT,
    version: async () => ({ ok: true, daemonVersion: "0.1.0-dev.38" }),
  });
  expect(output).toMatch(/^CLI: \S+\nDaemon: 0\.1\.0-dev\.38$/);
  expect(output).not.toContain("Computer:");
});

test("version --json wraps the same facts as { ok: true, data }", async () => {
  const output = await run(["version", "--json"], {
    ...MINIMAL_TRANSPORT,
    version: async () => ({
      ok: true,
      daemonVersion: "0.1.0-dev.38",
      computerVersion: "0.1.0-dev.38",
    }),
  });
  const parsed = JSON.parse(output as string) as {
    ok: boolean;
    data: { cli: string; daemon: string; computer: string };
  };
  expect(parsed.ok).toBe(true);
  expect(parsed.data.daemon).toBe("0.1.0-dev.38");
  expect(parsed.data.computer).toBe("0.1.0-dev.38");
  expect(typeof parsed.data.cli).toBe("string");
});

test("version surfaces the transport's CliError when the live daemon cannot be queried", async () => {
  try {
    await run(["version"], {
      ...MINIMAL_TRANSPORT,
      version: async () => {
        throw new CliError({
          code: "VERSION_FAILED",
          message: "The live daemon could not be queried: agent proxy request failed.",
          retryable: false,
        });
      },
    });
    throw new Error("expected a CliError");
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe("VERSION_FAILED");
  }
});
