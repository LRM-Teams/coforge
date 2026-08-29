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

const request = (agentToken?: string, daemonToken?: string) =>
  new Request("https://server.example/api/agent-messages", {
    method: "POST",
    headers: {
      ...(agentToken ? { authorization: `Bearer ${agentToken}` } : {}),
      ...(daemonToken ? { "x-coforge-daemon-authorization": `Bearer ${daemonToken}` } : {}),
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
      verifyDaemonToken: async (token) => {
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
      verifyDaemonToken: async (token: string) => {
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

  test("rejects credentials bound to another Computer, Workspace, owner, or registration", async () => {
    const keys = new MemoryAgentApiKeys();
    const apiKey = await createAgentApiKey({
      agentId: "agent-a",
      workspaceId: "workspace-a",
      ownerId: "owner-a",
      computerId: "computer-a",
      repository: keys,
    });
    for (const daemon of [
      { userId: "owner-b", workspaceId: "workspace-a", computerId: "computer-a" },
      { userId: "owner-a", workspaceId: "workspace-b", computerId: "computer-a" },
      { userId: "owner-a", workspaceId: "workspace-a", computerId: "computer-b" },
    ])
      await expect(
        authenticateAgentMessageRequest(request(apiKey, "daemon-token"), {
          agentApiKeys: keys,
          verifyDaemonToken: async () => daemon,
          computerBelongsToWorkspace: async () => true,
        }),
      ).rejects.toThrow();
    await expect(
      authenticateAgentMessageRequest(request(apiKey, "daemon-token"), {
        agentApiKeys: keys,
        verifyDaemonToken: async () => ({
          userId: "owner-a",
          workspaceId: "workspace-a",
          computerId: "computer-a",
        }),
        computerBelongsToWorkspace: async () => false,
      }),
    ).rejects.toThrow();
  });
});
