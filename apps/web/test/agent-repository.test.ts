import { describe, expect, test } from "bun:test";
import {
  RepositoryAgentAuthorization,
  type AgentRecord,
  type AgentRepository,
} from "../src/server/db/repositories/agent.repositories.server";

function repository(): AgentRepository {
  const records: AgentRecord[] = [
    {
      id: "a1",
      workspaceId: "w1",
      name: "builder",
      displayName: "Builder",
      ownerId: "u1",
      createdAt: new Date(),
      runtimeConfig: { provider: "pi", model: "", reasoning: "" },
    },
  ];
  return {
    getById: async (id) => records.find((agent) => agent.id === id),
    listInWorkspace: async (workspaceId) =>
      records.filter((agent) => agent.workspaceId === workspaceId),
    listOwnedInWorkspace: async (workspaceId, ownerId) =>
      records.filter((agent) => agent.workspaceId === workspaceId && agent.ownerId === ownerId),
    create: async (input) => {
      const agent = { ...input, id: "created", createdAt: new Date() };
      records.push(agent);
      return agent;
    },
  };
}

describe("AgentRepository seam", () => {
  test("loads an agent by id", async () => {
    const agents = repository();
    expect(await agents.getById("a1")).toMatchObject({
      id: "a1",
      runtimeConfig: { provider: "pi", model: "", reasoning: "" },
    });
    expect(await agents.getById("missing")).toBeUndefined();
  });

  test("authorizes only the owning user in the owning workspace", async () => {
    const agents = repository();
    const authorization = new RepositoryAgentAuthorization(agents);
    expect(await authorization.canUseAgent("w1", "a1", "u1")).toBe(true);
    expect(await authorization.canUseAgent("w2", "a1", "u1")).toBe(false);
    expect(await authorization.canUseAgent("w1", "a1", "u2")).toBe(false);
  });

  test("lists only Agents owned by the requester in the Workspace", async () => {
    const agents = repository();
    expect(await agents.listOwnedInWorkspace("w1", "u1")).toHaveLength(1);
    expect(await agents.listOwnedInWorkspace("w1", "u2")).toEqual([]);
  });
});
