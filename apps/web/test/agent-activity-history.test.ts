import { expect, test } from "bun:test";
import type { PrismaClient } from "../generated/client";
import { AgentActivityRepository } from "../src/server/db/repositories/agent-activity.repositories.server";

test("chat activity history uses a compact parameterized member-scoped query", async () => {
  let query: unknown[] = [];
  const db = {
    $queryRaw: async (...input: unknown[]) => {
      query = input;
      return [
        {
          agentId: "agent-1",
          id: "activity-1",
          launchId: "launch-1",
          clientSeq: 7,
          activity: "idle",
          level: "info",
          occurredAt: new Date("2026-01-01T00:00:00Z"),
          createdAt: new Date("2026-01-01T00:00:01Z"),
          slot: 1n,
        },
        {
          agentId: "agent-empty",
          id: null,
          launchId: null,
          clientSeq: null,
          activity: null,
          level: null,
          occurredAt: null,
          createdAt: null,
          slot: null,
        },
      ];
    },
  } as unknown as PrismaClient;
  expect(await new AgentActivityRepository(db).listForMember("workspace-1", "user-1")).toEqual([
    {
      id: "agent-1",
      activity: [
        {
          id: "activity-1",
          launchId: "launch-1",
          clientSeq: 7,
          activity: "idle",
          level: "info",
          occurredAt: new Date("2026-01-01T00:00:00Z"),
          createdAt: new Date("2026-01-01T00:00:01Z"),
        },
      ],
    },
    { id: "agent-empty", activity: [] },
  ]);
  expect(query.slice(1)).toEqual(["workspace-1", "user-1", "workspace-1", "workspace-1"]);
  const sql = String.raw({ raw: query[0] as string[] });
  expect(sql).toContain("ROW_NUMBER() OVER");
  expect(sql).toContain('agent."workspaceId" = ');
  expect(sql).not.toContain("workspace-1");
  expect(sql).not.toContain("runtime_config");
  expect(sql).not.toContain('activity."message"');
});
