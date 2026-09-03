import { describe, expect, test } from "bun:test";

import {
  createAgentApiKey,
  type AgentApiKeyRecord,
  type AgentApiKeyRepository,
} from "../src/server/agents/agent-api-key.server";
import { authenticateAgentMessageRequest } from "../src/server/agents/agent-message-http.server";

class MemoryAgentApiKeys implements AgentApiKeyRepository {
  record?: AgentApiKeyRecord;
  async replaceActive(record: AgentApiKeyRecord) {
    this.record = record;
  }
  async findByHash(hash: string) {
    return this.record?.apiKeyHash === hash ? this.record : undefined;
  }
  async revoke() {}
}

const request = (agentToken?: string, daemonApiKey?: string) =>
  new Request("https://server.example/api/agent-messages", {
    method: "POST",
    headers: {
      ...(daemonApiKey ? { authorization: `Bearer ${daemonApiKey}` } : {}),
      ...(agentToken ? { "x-coforge-agent-api-key": `Bearer ${agentToken}` } : {}),
    },
  });

describe("Agent message HTTP authentication", () => {
  test("authenticates matching Agent and daemon credentials without a proxy secret", async () => {
    const keys = new MemoryAgentApiKeys();
    const apiKey = await createAgentApiKey({
      agentId: "agent-a",
      workspaceId: "workspace-a",
      ownerId: "owner-a",
      computerId: "computer-a",
      repository: keys,
    });
    const principal = await authenticateAgentMessageRequest(request(apiKey, "daemon-token"), {
      agentApiKeys: keys,
      verifyDaemonApiKey: async (token) => {
        if (token !== "daemon-token") throw new Error("invalid");
        return { userId: "owner-a", workspaceId: "workspace-a", computerId: "computer-a" };
      },
      computerBelongsToWorkspace: async () => true,
    });
    expect(principal).toEqual({
      userId: "owner-a",
      workspaceId: "workspace-a",
      computerId: "computer-a",
      agentId: "agent-a",
    });
  });

  test("authenticates an Agent owner through another member's assigned Computer", async () => {
    const keys = new MemoryAgentApiKeys();
    const apiKey = await createAgentApiKey({
      agentId: "agent-a",
      workspaceId: "workspace-a",
      ownerId: "agent-owner",
      computerId: "computer-a",
      repository: keys,
    });

    const principal = await authenticateAgentMessageRequest(request(apiKey, "daemon-token"), {
      agentApiKeys: keys,
      verifyDaemonApiKey: async () => ({
        userId: "computer-owner",
        workspaceId: "workspace-a",
        computerId: "computer-a",
      }),
      computerBelongsToWorkspace: async () => true,
    });

    expect(principal.userId).toBe("agent-owner");
  });

  test("rejects either missing or invalid credential", async () => {
    const keys = new MemoryAgentApiKeys();
    const apiKey = await createAgentApiKey({
      agentId: "agent-a",
      workspaceId: "workspace-a",
      ownerId: "owner-a",
      computerId: "computer-a",
      repository: keys,
    });
    const dependencies = {
      agentApiKeys: keys,
      verifyDaemonApiKey: async (token: string) => {
        if (token !== "daemon-token") throw new Error("invalid");
        return { userId: "owner-a", workspaceId: "workspace-a", computerId: "computer-a" };
      },
      computerBelongsToWorkspace: async () => true,
    };
    for (const candidate of [
      request(undefined, "daemon-token"),
      request(apiKey),
      request("sk_agent_invalid", "daemon-token"),
      request(apiKey, "invalid"),
    ])
      await expect(authenticateAgentMessageRequest(candidate, dependencies)).rejects.toThrow();
  });

  test("rejects credentials bound to another Computer, Workspace, or registration", async () => {
    const keys = new MemoryAgentApiKeys();
    const apiKey = await createAgentApiKey({
      agentId: "agent-a",
      workspaceId: "workspace-a",
      ownerId: "owner-a",
      computerId: "computer-a",
      repository: keys,
    });
    for (const daemon of [
      { userId: "owner-a", workspaceId: "workspace-b", computerId: "computer-a" },
      { userId: "owner-a", workspaceId: "workspace-a", computerId: "computer-b" },
    ])
      await expect(
        authenticateAgentMessageRequest(request(apiKey, "daemon-token"), {
          agentApiKeys: keys,
          verifyDaemonApiKey: async () => daemon,
          computerBelongsToWorkspace: async () => true,
        }),
      ).rejects.toThrow();
    await expect(
      authenticateAgentMessageRequest(request(apiKey, "daemon-token"), {
        agentApiKeys: keys,
        verifyDaemonApiKey: async () => ({
          userId: "owner-a",
          workspaceId: "workspace-a",
          computerId: "computer-a",
        }),
        computerBelongsToWorkspace: async () => false,
      }),
    ).rejects.toThrow();
  });
});
