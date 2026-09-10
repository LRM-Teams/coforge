import { describe, expect, test } from "bun:test";

import { AgentDetailQuery } from "../src/server/agents/agent-detail.server";
import { presentActivity, agentDisplay } from "../src/features/agents/agent-activity-presentation";
import type { AgentDisplaySnapshot } from "@coforge/protocol/agent-display";

function display(overrides: Partial<AgentDisplaySnapshot> = {}): AgentDisplaySnapshot {
  return {
    protocolMajor: 1,
    workspaceId: "workspace-1",
    computerId: "computer-1",
    agentId: "agent-1",
    revision: 7,
    activityKind: "working",
    detailKind: "model_request_started",
    detail: "Reviewing the release plan",
    entries: [],
    expiresAt: 99_000,
    ...overrides,
  };
}

test("formats only the cloud display decision even when its raw detail kind conflicts", () => {
  expect(
    agentDisplay(
      display({
        activityKind: "online",
        detailKind: "model_request_started",
        detail: "Raw model request",
      }),
    ),
  ).toEqual({
    kind: "online",
    label: "Online",
    isOnline: true,
    tone: "idle",
    pulse: false,
  });
  expect(
    agentDisplay(
      display({
        activityKind: "working",
        detailKind: "future_backend_kind",
        detail: "Backend customized work",
      }),
    ),
  ).toMatchObject({
    kind: "working",
    label: "Backend customized work",
    isOnline: true,
    pulse: true,
  });
  expect(
    agentDisplay(
      display({
        activityKind: "error",
        detailKind: "runtime_error",
        detail: "Provider rejected request",
      }),
    ),
  ).toMatchObject({
    kind: "error",
    label: "Error: Provider rejected request",
    isOnline: true,
    pulse: false,
  });
  expect(
    agentDisplay(
      display({
        activityKind: "offline",
        detailKind: "model_response_started",
        detail: "stale work",
      }),
    ),
  ).toMatchObject({
    kind: "offline",
    label: "Offline",
    isOnline: false,
    pulse: false,
  });
  expect(agentDisplay()).toEqual({
    kind: "unknown",
    label: "Status unknown",
    isOnline: undefined,
    tone: "unknown",
    pulse: false,
  });
});

test("status presentation uses backend detail instead of hardcoding the received message", () => {
  const observation = {
    activityKind: "working" as const,
    detailKind: "model_request_started",
    level: "info",
    detail: "Message received from #engineering",
  };
  expect(presentActivity(observation)).toMatchObject([
    {
      label: "Working",
      detail: "Message received from #engineering",
      recentLabel: "Message received from #engineering",
      currentLabel: "Message received from #engineering",
      tone: "working",
    },
  ]);
  expect(presentActivity({ ...observation, level: "error" })).toMatchObject([
    {
      label: "Error",
      recentLabel: "Error: Message received from #engineering",
      tone: "error",
      currentLabel: null,
    },
  ]);
  expect(
    presentActivity({ ...observation, activityKind: undefined, detailKind: "future_activity" }),
  ).toMatchObject([
    {
      label: "Activity",
      detail: observation.detail,
      recentLabel: observation.detail,
      currentLabel: null,
    },
  ]);
});

test("structured tools separate the label from command and path details", () => {
  const observation = {
    activityKind: "working" as const,
    detailKind: "tool_started",
    level: "info",
    detail: "src/private.ts",
  };
  expect(
    presentActivity({ ...observation, entries: [{ kind: "tool_start", toolName: "read_file" }] }),
  ).toMatchObject([
    {
      label: "Reading file",
      detail: "src/private.ts",
      recentLabel: "Reading file",
      currentLabel: "Reading file…",
      tone: "working",
      monospace: true,
      pulse: false,
    },
  ]);
  expect(
    presentActivity({
      ...observation,
      detail: "bun test",
      entries: [{ kind: "tool_start", toolName: "bash" }],
    }),
  ).toMatchObject([
    {
      label: "Running command",
      detail: "bun test",
      recentLabel: "Running command",
      currentLabel: "Running command…",
    },
  ]);
  expect(
    presentActivity({
      ...observation,
      entries: [{ kind: "tool_start", toolName: "mcp__custom__inspect" }],
    }),
  ).toMatchObject([{ label: "inspect", recentLabel: "inspect", currentLabel: "Using inspect…" }]);
  expect(
    presentActivity({
      ...observation,
      entries: [{ kind: "tool_start", toolName: "send_message" }],
    }),
  ).toEqual([]);
});

test("thinking and output entries stay separate and retain provider text and lineage", () => {
  expect(
    presentActivity({
      activityKind: "thinking",
      detailKind: "model_response_started",
      level: "info",
      detail: "",
      entries: [
        { kind: "thinking", text: "检查两个边界", subagent: { parentToolUseId: "parent-1" } },
        { kind: "text", text: "<script>not executable</script>" },
      ],
    }),
  ).toMatchObject([
    {
      label: "Thinking",
      detail: "检查两个边界",
      recentLabel: "检查两个边界",
      currentLabel: "Thinking…",
      tone: "thinking",
      expandable: true,
      subagent: { parentToolUseId: "parent-1" },
    },
    {
      label: "Output",
      detail: "<script>not executable</script>",
      recentLabel: "<script>not executable</script>",
      currentLabel: "Working…",
      tone: "output",
      recentTone: "working",
      expandable: true,
    },
  ]);
});

test("reconnecting uses backend detail for current status while retaining raw timeline output", () => {
  const reconnecting = display({
    detailKind: "runtime_reconnecting",
    detail: "Codex reconnecting to provider…",
    entries: [{ kind: "text", text: "Reconnecting... 2/5 (unexpected status 502 Bad Gateway)" }],
  });

  expect(agentDisplay(reconnecting)).toMatchObject({
    kind: "working",
    label: "Codex reconnecting to provider…",
  });
  expect(presentActivity({ ...reconnecting, level: "info" })).toMatchObject([
    {
      label: "Output",
      detail: "Reconnecting... 2/5 (unexpected status 502 Bad Gateway)",
      recentLabel: "Reconnecting... 2/5 (unexpected status 502 Bad Gateway)",
      currentLabel: "Codex reconnecting to provider…",
    },
  ]);
});

describe("Agent detail", () => {
  test("keeps authorized profile and Activity available when status cannot be read", async () => {
    const activity = [
      {
        id: "activity-1",
        computerId: "computer-1",
        launchId: "launch-1",
        clientSeq: 1,
        detailKind: "model_response_started",
        level: "info",
        detail: "Working",
        observedAtMs: Date.parse("2026-08-29T02:00:00Z"),
        createdAt: new Date("2026-08-29T02:00:01Z"),
      },
    ];
    const query = new AgentDetailQuery(
      {
        findAuthorized: async () => ({
          id: "agent-1",
          workspaceId: "workspace-1",
          name: "builder",
          displayName: "Builder",
          createdAt: new Date("2026-08-29T00:00:00Z"),
          computerId: "computer-1",
          owner: { id: "owner-1", username: "alice" },
          runtimeConfig: {},
        }),
        listActivity: async () => activity,
      },
      {
        snapshot: async () => {
          throw new Error("Redis unavailable");
        },
      },
    );

    const result = await query.get("workspace-1", "agent-1", "viewer-1");

    expect(result?.displayName).toBe("Builder");
    expect(result?.activity).toEqual(activity);
    expect(result?.status).toEqual({
      value: "unknown",
      expiresAt: null,
      ordering: null,
    });
  });

  test("returns the complete profile and newest-first Activity to a Workspace member", async () => {
    const query = new AgentDetailQuery({
      findAuthorized: async () => ({
        id: "agent-1",
        workspaceId: "workspace-1",
        name: "builder",
        displayName: "Builder",
        createdAt: new Date("2026-08-29T00:00:00Z"),
        owner: { id: "owner-1", username: "alice" },
        runtimeConfig: {
          runtime: "codex",
          provider: { kind: "default" },
          model: "gpt-5",
          reasoning: "high",
        },
      }),
      listActivity: async () => [
        {
          id: "activity-2",
          computerId: "computer-12345678",
          launchId: "launch-2",
          clientSeq: 2,
          detailKind: "model_response_started",
          level: "info",
          detail: "Working",
          observedAtMs: Date.parse("2026-08-29T02:00:00Z"),
          createdAt: new Date("2026-08-29T02:00:01Z"),
        },
        {
          id: "activity-1",
          computerId: "computer-old",
          launchId: "launch-1",
          clientSeq: 1,
          detailKind: "runtime_error",
          level: "error",
          detail: "Agent runtime could not be started.",
          observedAtMs: Date.parse("2026-08-29T01:00:00Z"),
          createdAt: new Date("2026-08-29T01:00:01Z"),
        },
      ],
    });

    const result = await query.get("workspace-1", "agent-1", "viewer-1");
    expect(result?.owner.username).toBe("alice");
    expect(result?.runtimeConfig).toEqual({
      runtime: "codex",
      provider: { kind: "default" },
      model: "gpt-5",
      reasoning: "high",
    });
    expect(result?.computer).toEqual({
      id: "computer-12345678",
      label: "computer…5678",
    });
    expect(result?.latestError).toBeUndefined();
    expect(result?.activity.map((entry) => entry.id)).toEqual(["activity-2", "activity-1"]);
  });

  test.each([
    ["starting", "info", false],
    ["model_response_started", "info", false],
    ["thinking_started", "info", false],
    ["idle", "info", false],
    ["stopped", "info", true],
    ["warning", "warning", true],
    ["unknown", "info", true],
    ["running", "info", true],
    ["error", "error", true],
  ])("only recovery supersedes failures: %s", async (detailKind, level, showError) => {
    const entries = [
      { id: "new", detailKind, level },
      { id: "failure", detailKind: "runtime_error", level: "error" },
      { id: "old-start", detailKind: "starting", level: "info" },
    ].map((entry, index) => ({
      ...entry,
      computerId: "computer-1",
      launchId: "launch-1",
      clientSeq: 3 - index,
      detail: entry.detailKind,
      observedAtMs: 3000 - index * 1000,
      createdAt: new Date(3000 - index * 1000),
    }));
    const query = new AgentDetailQuery({
      findAuthorized: async () => ({
        id: "agent-1",
        workspaceId: "workspace-1",
        name: "builder",
        displayName: "Builder",
        createdAt: new Date(0),
        owner: { id: "owner-1", username: "alice" },
        runtimeConfig: {},
      }),
      listActivity: async () => entries,
    });
    const result = await query.get("workspace-1", "agent-1", "viewer-1");
    expect(result?.latestError?.id).toBe(
      showError ? (level === "error" ? "new" : "failure") : undefined,
    );
    expect(result?.activity).toEqual(entries);
  });

  test("does not expose an Agent outside the viewer's Workspace authorization", async () => {
    const query = new AgentDetailQuery({
      findAuthorized: async () => undefined,
      listActivity: async () => {
        throw new Error("must not load activity");
      },
    });
    expect(await query.get("workspace-1", "agent-1", "outsider")).toBeUndefined();
  });
});
