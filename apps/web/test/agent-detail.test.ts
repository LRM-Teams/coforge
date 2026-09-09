import { describe, expect, test } from "bun:test";

import { AgentDetailQuery } from "../src/server/agents/agent-detail.server";
import {
  activityLabel,
  showsActivityMessage,
} from "../src/features/agents/agent-activity-presentation";

test("official thinking observation has a Thinking label and preserves its detail", () => {
  expect(activityLabel("thinking_started", "info")).toBe("Thinking");
  expect(showsActivityMessage("thinking_started")).toBe(true);
});

test("error activity uses an Error label and shows its message", () => {
  expect(activityLabel("runtime_error", "error")).toBe("Error");
  expect(showsActivityMessage("runtime_error")).toBe(true);
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
