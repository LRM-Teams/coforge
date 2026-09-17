import { describe, expect, test } from "bun:test";

import { AgentDetailQuery } from "../src/server/agents/agent-detail.server";
import {
  presentActivity,
  presentActivityRows,
  agentDisplay,
} from "../src/features/agents/agent-activity-presentation";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";
import type { ActivityEntry } from "../src/features/agents/agent-activity";

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

test("a stopped Agent (ADR 0038) keeps its real display kind and label, adding only a status caption", () => {
  const offline = display({ activityKind: "offline", detailKind: "model_response_started" });
  expect(agentDisplay(offline, { stopped: true })).toMatchObject({
    kind: "offline",
    label: "Offline",
    isOnline: false,
    statusDetail: "Stopped — won't receive messages until restarted",
  });
  // Not stopped: no caption at all.
  expect(agentDisplay(offline, { stopped: false }).statusDetail).toBeUndefined();
  expect(agentDisplay(offline).statusDetail).toBeUndefined();
  // Stopped but the display is not (yet) offline: the real kind and label are not overridden.
  const working = display({ activityKind: "working", detailKind: "model_request_started" });
  const view = agentDisplay(working, { stopped: true });
  expect(view.kind).toBe("working");
  expect(view.isOnline).toBe(true);
  expect(view.statusDetail).toBeUndefined();
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

// ADR 0021
test("compacting_context uses a dedicated label instead of the generic working text", () => {
  const observation = {
    activityKind: "working" as const,
    detailKind: "compacting_context",
    level: "info",
    detail: "",
  };
  expect(presentActivity(observation)).toMatchObject([
    {
      label: "Compacting context",
      recentLabel: "Compacting context…",
      currentLabel: "Compacting context…",
      tone: "working",
    },
  ]);
});

// ADR 0021, amended
test.each([
  ["tool_end", "Tool finished"],
  ["thinking_end", "Thinking finished"],
  ["compaction_finished", "Compaction finished"],
])(
  "%s renders one status row: primary label from the activity kind, secondary text naming what finished",
  (detailKind, secondary) => {

test.each([
  ["reviewing_changes", "Reviewing changes", "Reviewing changes…"],
  ["review_finished", "Review finished", "Review finished"],
  ["compaction_stale", "Compaction still running", "Compaction still running…"],
  ["review_stale", "Review still running", "Review still running…"],
  ["stalled_recovery", "Restarting stalled provider", "Restarting stalled provider…"],
])(
  "%s uses a dedicated label instead of the generic working text",
  (detailKind, label, recentLabel) => {
    const observation = {
      activityKind: "working" as const,
      detailKind,
      level: "info",
      detail: "",
    };
    expect(presentActivity(observation)).toMatchObject([
      { label: "Working", detail: secondary, tone: "working", monospace: false, expandable: false },

      { label, recentLabel, currentLabel: recentLabel, tone: "working" },
    ]);
  },
);

test("a daemon-sent tool_end/thinking_end detail wins over the fallback wording", () => {
  const observation = {
    activityKind: "working" as const,
    detailKind: "tool_end",
    level: "info",
    detail: "Tool finished after 3 retries",
  };
  expect(presentActivity(observation)).toMatchObject([
    { label: "Working", detail: "Tool finished after 3 retries" },
  ]);
});

test("runtime_progress has no secondary text (it never reaches the timeline, but stays harmless if it did)", () => {
  const observation = {
    activityKind: "working" as const,
    detailKind: "runtime_progress",
    level: "info",
    detail: "",
  };
  expect(presentActivity(observation)).toMatchObject([{ label: "Working", detail: "" }]);
});

test("a tool_end status row between two text fragments closes the merge group like any other atom", () => {
  const activity = [
    textFrame(3, "after"),
    frame({ clientSeq: 2, detailKind: "tool_end", detail: "", activityKind: "working" }),
    textFrame(1, "before"),
  ];
  const rows = presentActivityRows(activity);
  expect(rows.map((row) => row.label)).toEqual(["Output", "Working", "Output"]);
  expect(rows.map((row) => row.detail)).toEqual(["after", "Tool finished", "before"]);

test("runtime_stalled presents with a dedicated Stalled label at error tone", () => {
  const observation = {
    activityKind: "error" as const,
    detailKind: "runtime_stalled",
    level: "error",
    detail: "",
  };
  expect(presentActivity(observation)).toMatchObject([
    { label: "Stalled", recentLabel: "Stalled", tone: "error" },
  ]);
  expect(presentActivity({ ...observation, detail: "no output for 10 minutes" })).toMatchObject([
    { label: "Stalled", recentLabel: "Stalled: no output for 10 minutes" },
  ]);
});

test("system_message has no dedicated label and falls back to its own detail", () => {
  const observation = {
    activityKind: "working" as const,
    detailKind: "system_message",
    level: "info",
    detail: "The daemon restarted your session.",
  };
  expect(presentActivity(observation)).toMatchObject([
    {
      label: "Working",
      recentLabel: "The daemon restarted your session.",
      currentLabel: "The daemon restarted your session.",
      tone: "working",
    },
  ]);
});

test("a system entry shows its title as the label and its text as the detail", () => {
  const observation = {
    activityKind: "working" as const,
    detailKind: "system_message",
    level: "info",
    detail: "",
    entries: [
      {
        kind: "system" as const,
        title: "Session reset",
        text: "The daemon restarted the session.",
      },
    ],
  };
  expect(presentActivity(observation)).toMatchObject([
    {
      label: "Session reset",
      detail: "The daemon restarted the session.",
      recentLabel: "Session reset",
      currentLabel: "Session reset",
      expandable: true,
    },
  ]);
});

test("a tool_start entry's toolInput takes precedence over the activity's own detail", () => {
  const observation = {
    activityKind: "working" as const,
    detailKind: "tool_started",
    level: "info",
    detail: "fallback detail from an older daemon",
  };
  expect(
    presentActivity({
      ...observation,
      entries: [{ kind: "tool_start", toolName: "bash", toolInput: "ls -la /tmp" }],
    }),
  ).toMatchObject([{ label: "Running command", detail: "ls -la /tmp" }]);
  // Older daemons/stored rows carry no toolInput: keeps using the activity's own detail.
  expect(
    presentActivity({
      ...observation,
      entries: [{ kind: "tool_start", toolName: "bash" }],
    }),
  ).toMatchObject([{ label: "Running command", detail: "fallback detail from an older daemon" }]);
});

test("subagent_activity always shows one unified label, even with entries", () => {
  const observation = {
    activityKind: "working" as const,
    detailKind: "subagent_activity",
    level: "info",
    detail: "",
    entries: [
      { kind: "tool_start" as const, toolName: "bash", subagent: { parentToolUseId: "t1" } },
    ],
  };
  expect(presentActivity(observation)).toEqual([
    {
      label: "Subagent working",
      detail: "",
      recentLabel: "Subagent working…",
      currentLabel: "Subagent working…",
      tone: "working",
      recentTone: "working",
      pulse: true,
      monospace: false,
      expandable: false,
    },
  ]);
  expect(presentActivity({ ...observation, level: "error", detail: "boom" })).toMatchObject([
    { label: "Error", tone: "error" },
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

// presentActivityRows merges buffered fragments of one statement into a single row
// (Kiro delivers ~500ms bursts; the daemon flushes each burst as its own frame).
function frame(overrides: Partial<ActivityEntry> & { clientSeq: number }): ActivityEntry {
  return {
    launchId: "launch-1",
    detailKind: "model_response_started",
    level: "info",
    detail: "",
    observedAtMs: overrides.clientSeq * 1000,
    entries: [],
    ...overrides,
  };
}
function textFrame(
  clientSeq: number,
  text: string,
  overrides: Partial<ActivityEntry> = {},
): ActivityEntry {
  return frame({ clientSeq, entries: [{ kind: "text", text }], ...overrides });
}

test("presentActivityRows merges 14 buffered text fragments of one statement into one Output row", () => {
  const fragments = Array.from({ length: 14 }, (_, index) => index + 1)
    .map((clientSeq) => textFrame(clientSeq, `frag${clientSeq}-`))
    .reverse(); // orderActivity contract: newest-first
  const rows = presentActivityRows(fragments);
  expect(rows).toHaveLength(1);
  expect(rows[0].label).toBe("Output");
  expect(rows[0].detail).toBe(
    Array.from({ length: 14 }, (_, index) => `frag${index + 1}-`).join(""),
  );
  expect(rows[0].observedAtMs).toBe(1000); // the oldest fragment's timestamp
});

test("newest-first input order still concatenates fragments oldest-to-newest", () => {
  const rows = presentActivityRows([textFrame(2, "-world"), textFrame(1, "hello")]);
  expect(rows).toHaveLength(1);
  expect(rows[0].detail).toBe("hello-world");
});

test("text, text, tool, text keeps two Output rows around the visible tool row", () => {
  const activity = [
    textFrame(4, "after"),
    frame({
      clientSeq: 3,
      detailKind: "tool_started",
      detail: "bun test",
      entries: [{ kind: "tool_start", toolName: "bash" }],
    }),
    textFrame(2, "-second"),
    textFrame(1, "first"),
  ];
  const rows = presentActivityRows(activity);
  expect(rows.map((row) => row.label)).toEqual(["Output", "Running command", "Output"]);
  expect(rows[0].detail).toBe("after");
  expect(rows[2].detail).toBe("first-second");
});

test("a hidden send_message tool call between fragments still separates them", () => {
  const activity = [
    textFrame(4, "final part"),
    frame({
      clientSeq: 3,
      detailKind: "tool_started",
      entries: [{ kind: "tool_start", toolName: "send_message" }],
    }),
    textFrame(2, "second"),
    textFrame(1, "first"),
  ];
  // The tool_start entry produces no visible row (send_message is hidden), but it is
  // still a real tool call between two statements: it must not merge across it.
  expect(presentActivity(activity[1])).toEqual([]);
  const rows = presentActivityRows(activity);
  expect(rows.map((row) => row.label)).toEqual(["Output", "Output"]);
  expect(rows[0].detail).toBe("final part");
  expect(rows[1].detail).toBe("firstsecond");
});

test("a system entry closes an open statement merge group instead of merging into it", () => {
  const activity = [
    textFrame(3, "after"),
    frame({
      clientSeq: 2,
      entries: [{ kind: "system", title: "Session reset", text: "restarted" }],
    }),
    textFrame(1, "before"),
  ];
  const rows = presentActivityRows(activity);
  expect(rows.map((row) => row.label)).toEqual(["Output", "Session reset", "Output"]);
  expect(rows.map((row) => row.detail)).toEqual(["after", "restarted", "before"]);
});

test("text followed by thinking does not merge", () => {
  const activity = [
    frame({ clientSeq: 2, entries: [{ kind: "thinking", text: "thought" }] }),
    textFrame(1, "said"),
  ];
  const rows = presentActivityRows(activity);
  expect(rows.map((row) => row.label)).toEqual(["Thinking", "Output"]);
});

test("fragments from different launches do not merge", () => {
  const rows = presentActivityRows([
    textFrame(1, "b", { launchId: "launch-2" }),
    textFrame(1, "a"),
  ]);
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.detail)).toEqual(["b", "a"]);
});

test("fragments from different subagent lineage do not merge", () => {
  const activity = [
    frame({
      clientSeq: 2,
      entries: [{ kind: "text", text: "b", subagent: { parentToolUseId: "t2" } }],
    }),
    frame({
      clientSeq: 1,
      entries: [{ kind: "text", text: "a", subagent: { parentToolUseId: "t1" } }],
    }),
  ];
  const rows = presentActivityRows(activity);
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.detail)).toEqual(["b", "a"]);
});

test("an error-level row never merges with surrounding text fragments", () => {
  const activity = [
    textFrame(3, "after"),
    frame({
      clientSeq: 2,
      detailKind: "runtime_error",
      level: "error",
      detail: "boom",
      entries: [{ kind: "text", text: "ignored" }],
    }),
    textFrame(1, "before"),
  ];
  const rows = presentActivityRows(activity);
  expect(rows.map((row) => row.tone)).toEqual(["output", "error", "output"]);
  expect(rows.map((row) => row.detail)).toEqual(["after", "boom", "before"]);
});

test("a newly appended fragment keeps the same row key as the statement grows", () => {
  const before = presentActivityRows([textFrame(1, "hello")]);
  const after = presentActivityRows([textFrame(2, "-world"), textFrame(1, "hello")]);
  expect(after[0].key).toBe(before[0].key);
  expect(after[0].detail).toBe("hello-world");
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
          role: "member",
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

  test("exposes stopped from stoppedAt (ADR 0038)", async () => {
    const baseAgent = {
      id: "agent-1",
      workspaceId: "workspace-1",
      name: "builder",
      displayName: "Builder",
      role: "member",
      createdAt: new Date("2026-08-29T00:00:00Z"),
      computerId: "computer-1",
      owner: { id: "owner-1", username: "alice" },
      runtimeConfig: {},
    };
    const stoppedQuery = new AgentDetailQuery({
      findAuthorized: async () => ({ ...baseAgent, stoppedAt: new Date("2026-09-17T00:00:00Z") }),
      listActivity: async () => [],
    });
    expect((await stoppedQuery.get("workspace-1", "agent-1", "viewer-1"))?.stopped).toBe(true);

    const runningQuery = new AgentDetailQuery({
      findAuthorized: async () => ({ ...baseAgent, stoppedAt: null }),
      listActivity: async () => [],
    });
    expect((await runningQuery.get("workspace-1", "agent-1", "viewer-1"))?.stopped).toBe(false);
  });

  test("returns the complete profile and newest-first Activity to a Workspace member", async () => {
    const query = new AgentDetailQuery({
      findAuthorized: async () => ({
        id: "agent-1",
        workspaceId: "workspace-1",
        name: "builder",
        displayName: "Builder",
        role: "member",
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
    expect(result?.computer).toBeUndefined();
    expect(result?.latestError).toBeUndefined();
    expect(result?.activity.map((entry) => entry.id)).toEqual(["activity-2", "activity-1"]);
  });

  test("labels the assigned Computer by display name instead of a truncated id", async () => {
    const query = new AgentDetailQuery({
      findAuthorized: async () => ({
        id: "agent-1",
        workspaceId: "workspace-1",
        name: "builder",
        displayName: "Builder",
        role: "member",
        createdAt: new Date("2026-08-29T00:00:00Z"),
        computerId: "computer-assigned",
        computer: {
          id: "computer-assigned",
          name: "franks-mac.local",
          displayName: "Frank’s Mac",
          kind: "local",
        },
        owner: { id: "owner-1", username: "alice" },
        runtimeConfig: {},
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
      ],
    });

    const result = await query.get("workspace-1", "agent-1", "viewer-1");
    expect(result?.computer).toEqual({
      id: "computer-assigned",
      label: "Frank’s Mac",
      kind: "local",
      computerVersion: null,
    });
  });

  test("falls back to the Computer hostname when display name is empty", async () => {
    const query = new AgentDetailQuery({
      findAuthorized: async () => ({
        id: "agent-1",
        workspaceId: "workspace-1",
        name: "builder",
        displayName: "Builder",
        role: "member",
        createdAt: new Date(0),
        computerId: "computer-assigned",
        computer: {
          id: "computer-assigned",
          name: "build-box",
          displayName: "  ",
          kind: "cloud",
        },
        owner: { id: "owner-1", username: "alice" },
        runtimeConfig: {},
      }),
      listActivity: async () => [],
    });

    const result = await query.get("workspace-1", "agent-1", "viewer-1");
    expect(result?.computer).toEqual({
      id: "computer-assigned",
      label: "build-box",
      kind: "cloud",
      computerVersion: null,
    });
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
        role: "member",
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
