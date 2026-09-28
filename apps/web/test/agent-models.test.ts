import { describe, expect, test } from "bun:test";

import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { listVisibleAgentModels } from "#src/server/agents/agent-models.server";
import type { AgentVisibilityViewer } from "#src/server/agents/agent-visibility.server";

const WORKSPACE_ID = "workspace-1";
const member: AgentVisibilityViewer = { kind: "user", userId: "user-member", role: "member" };

function fakeDb(rows: Array<{ id: string; runtimeConfig: unknown }>) {
  const calls: Prisma.AgentFindManyArgs[] = [];
  const db = {
    agent: {
      findMany: async (args: Prisma.AgentFindManyArgs) => {
        calls.push(args);
        return rows;
      },
    },
  } as unknown as Pick<PrismaClient, "agent">;
  return { db, calls };
}

const config = (model: string) => ({
  runtime: "claude-code",
  provider: { kind: "default" },
  model,
  modelProvider: "",
  reasoning: "",
});

describe("listVisibleAgentModels", () => {
  test("reads only live Agents in the Workspace that the viewer may see", async () => {
    const { db, calls } = fakeDb([]);
    await listVisibleAgentModels(db, WORKSPACE_ID, member);
    expect(calls[0]?.where).toEqual({
      workspaceId: WORKSPACE_ID,
      deletedAt: null,
      OR: [{ visibility: "public" }, { ownerId: "user-member" }],
    });
  });

  test("maps each Agent to its configured model", async () => {
    const { db } = fakeDb([
      { id: "agent-a", runtimeConfig: config("claude-opus-5-5") },
      { id: "agent-b", runtimeConfig: config("gpt-5.5") },
    ]);
    expect((await listVisibleAgentModels(db, WORKSPACE_ID, member)).models).toEqual({
      "agent-a": "claude-opus-5-5",
      "agent-b": "gpt-5.5",
    });
  });

  test("lists an Agent on its runtime's default model, or with an unreadable config, with no model", async () => {
    const { db } = fakeDb([
      { id: "agent-default", runtimeConfig: config("") },
      { id: "agent-broken", runtimeConfig: { runtime: "claude-code" } },
      { id: "agent-set", runtimeConfig: config("claude-sonnet-5") },
    ]);
    expect((await listVisibleAgentModels(db, WORKSPACE_ID, member)).models).toEqual({
      "agent-default": "",
      "agent-broken": "",
      "agent-set": "claude-sonnet-5",
    });
  });

  test("stamps the list with the server's own read time, the clock message times come from", async () => {
    const { db } = fakeDb([]);
    const list = await listVisibleAgentModels(db, WORKSPACE_ID, member, () => 1_700_000_000_000);
    expect(list.readAt).toBe(1_700_000_000_000);
  });

  test("takes the read time before reading, so the list covers everything before it", async () => {
    let clock = 1_000;
    const db = {
      agent: {
        findMany: async () => {
          clock = 2_000;
          return [];
        },
      },
    } as unknown as Pick<PrismaClient, "agent">;
    const list = await listVisibleAgentModels(db, WORKSPACE_ID, member, () => clock);
    expect(list.readAt).toBe(1_000);
  });

  test("an owner or admin reads every live Agent in the Workspace", async () => {
    const { db, calls } = fakeDb([]);
    await listVisibleAgentModels(db, WORKSPACE_ID, {
      kind: "user",
      userId: "user-admin",
      role: "admin",
    });
    expect(calls[0]?.where).toEqual({ workspaceId: WORKSPACE_ID, deletedAt: null });
  });
});
