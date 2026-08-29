import { describe, expect, test } from "bun:test";

import { AgentDetailQuery } from "../src/server/agents/agent-detail.server";

describe("Agent detail", () => {
  test("returns the complete profile and newest-first Activity to a Workspace member", async () => {
    const query = new AgentDetailQuery({
      findAuthorized: async () => ({
        id: "agent-1",
        workspaceId: "workspace-1",
        name: "builder",
        displayName: "Builder",
        createdAt: new Date("2026-08-29T00:00:00Z"),
        owner: { id: "owner-1", username: "alice" },
        runtimeConfig: { provider: "codex", model: "gpt-5", reasoning: "high" },
      }),
      listActivity: async () => [
        {
          id: "activity-2",
          computerId: "computer-12345678",
          launchId: "launch-2",
          clientSeq: 2,
          activity: "running",
          level: "info",
          message: "Running",
          occurredAt: new Date("2026-08-29T02:00:00Z"),
          createdAt: new Date("2026-08-29T02:00:01Z"),
        },
        {
          id: "activity-1",
          computerId: "computer-old",
          launchId: "launch-1",
          clientSeq: 1,
          activity: "launch_failed",
          level: "error",
          message: "Agent runtime could not be started.",
          occurredAt: new Date("2026-08-29T01:00:00Z"),
          createdAt: new Date("2026-08-29T01:00:01Z"),
        },
      ],
    });

    const result = await query.get("workspace-1", "agent-1", "viewer-1");
    expect(result?.owner.username).toBe("alice");
    expect(result?.runtimeConfig).toEqual({ provider: "codex", model: "gpt-5", reasoning: "high" });
    expect(result?.computer).toEqual({ id: "computer-12345678", label: "computer…5678" });
    expect(result?.latestError?.id).toBe("activity-1");
    expect(result?.activity.map((entry) => entry.id)).toEqual(["activity-2", "activity-1"]);
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
