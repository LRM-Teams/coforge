import { expect, test } from "bun:test";
import type { PrismaClient } from "@/generated/prisma/client";
import { AgentActivityRepository } from "@/server/db/repositories/agent-activity.repositories.server";

test("chat activity history uses a compact parameterized member-scoped query", async () => {
  let query: unknown[] = [];
  const db = {
    workspaceMembership: { findUnique: async () => ({ role: "member" }) },
    agent: {
      // The viewer's own visible-Agent ids are read once, through the shared
      // `visibleAgentWhere` seam, and passed into the CTE's WHERE — never re-derived in SQL.
      findMany: async () => [{ id: "agent-1" }, { id: "agent-empty" }],
    },
    $queryRaw: async (...input: unknown[]) => {
      query = input;
      return [
        {
          agentId: "agent-1",
          id: "activity-1",
          launchId: "launch-1",
          clientSeq: 7,
          detailKind: "idle",
          level: "info",
          detail: "",
          occurredAt: new Date("2026-01-01T00:00:00Z"),
          entries: [],
          createdAt: new Date("2026-01-01T00:00:00Z"),
          slot: 1n,
        },
        {
          agentId: "agent-empty",
          id: null,
          launchId: null,
          clientSeq: null,
          detailKind: null,
          level: null,
          occurredAt: null,
          entries: null,
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
          detailKind: "idle",
          level: "info",
          detail: "",
          activityKind: "online",
          observedAtMs: new Date("2026-01-01T00:00:00Z").getTime(),
          entries: [],
          createdAt: new Date("2026-01-01T00:00:00Z"),
        },
      ],
    },
    { id: "agent-empty", activity: [] },
  ]);
  // Two WHERE clauses now also exclude the popover-hidden status kinds:
  // tool_end, thinking_end, compaction_finished, review_finished, once per CTE.
  const excludedKinds = ["tool_end", "thinking_end", "compaction_finished", "review_finished"];
  expect(query.slice(1)).toEqual([
    "workspace-1",
    "user-1",
    ["agent-1", "agent-empty"],
    "workspace-1",
    ...excludedKinds,
    "workspace-1",
    ...excludedKinds,
  ]);
  const sql = String.raw({ raw: query[0] as string[] });
  expect(sql).toContain("ROW_NUMBER() OVER");
  expect(sql).toContain('agent."workspaceId" = ');
  expect(sql).toContain('agent."id" = ANY(');
  expect(sql).toContain('activity."detailKind" NOT IN');
  expect(sql).not.toContain("workspace-1");
  expect(sql).not.toContain("runtime_config");
  expect(sql).not.toContain('activity."message"');
  expect(sql).toContain('compact."detail"');
});

test("chat activity history never runs the compact query when the viewer can see no Agent", async () => {
  let queried = false;
  const db = {
    workspaceMembership: { findUnique: async () => ({ role: "member" }) },
    agent: { findMany: async () => [] },
    $queryRaw: async () => {
      queried = true;
      return [];
    },
  } as unknown as PrismaClient;

  expect(await new AgentActivityRepository(db).listForMember("workspace-1", "user-1")).toEqual([]);
  expect(queried).toBe(false);
});
