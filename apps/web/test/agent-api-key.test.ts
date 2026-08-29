import { expect, test } from "bun:test";
import {
  authenticateAgentApiKey,
  createAgentApiKey,
  findAgentApiKey,
  hashAgentApiKey,
  isAgentApiKeyBoundToComputer,
  type AgentApiKeyRecord,
  type AgentApiKeyRepository,
} from "../src/server/agents/agent-api-key.server";

class MemoryAgentApiKeys implements AgentApiKeyRepository {
  records = new Map<string, AgentApiKeyRecord>();

  async replaceActive(record: AgentApiKeyRecord) {
    for (const current of this.records.values())
      if (
        current.agentId === record.agentId &&
        current.workspaceId === record.workspaceId &&
        current.ownerId === record.ownerId &&
        !current.revokedAt
      )
        current.revokedAt = new Date();
    this.records.set(record.apiKeyHash, record);
  }

  async findByHash(hash: string) {
    return this.records.get(hash);
  }

  async revoke(id: string) {
    for (const record of this.records.values()) if (record.id === id) record.revokedAt = new Date();
  }
}

test("Agent API key is returned once, stored only as a computer-bound hash, and revoked", async () => {
  const repository = new MemoryAgentApiKeys();
  const apiKey = await createAgentApiKey({
    agentId: "agent-a",
    workspaceId: "workspace-a",
    ownerId: "owner-a",
    computerId: "computer-a",
    repository,
  });

  expect(apiKey).toMatch(/^sk_agent_[A-Za-z0-9_-]{43}$/);
  expect([...repository.records.keys()]).toEqual([hashAgentApiKey(apiKey)]);
  expect(JSON.stringify([...repository.records.values()])).not.toContain(apiKey);
  const principal = await authenticateAgentApiKey(apiKey, repository);
  expect(principal).toMatchObject({
    agentId: "agent-a",
    workspaceId: "workspace-a",
    ownerId: "owner-a",
    computerId: "computer-a",
  });

  await repository.revoke(principal.id);
  await expect(authenticateAgentApiKey(apiKey, repository)).rejects.toThrow(
    "invalid Agent API key",
  );
  expect(await findAgentApiKey(apiKey, repository)).toMatchObject({
    id: principal.id,
    revokedAt: expect.any(Date),
  });
  await repository.revoke(principal.id);
  expect((await findAgentApiKey(apiKey, repository)).id).toBe(principal.id);
});

test("creating an Agent API key atomically revokes a crash-left active key", async () => {
  const repository = new MemoryAgentApiKeys();
  const input = {
    agentId: "agent-a",
    workspaceId: "workspace-a",
    ownerId: "owner-a",
    computerId: "computer-a",
    repository,
  };
  const oldApiKey = await createAgentApiKey(input);
  const newApiKey = await createAgentApiKey(input);

  await expect(authenticateAgentApiKey(oldApiKey, repository)).rejects.toThrow(
    "invalid Agent API key",
  );
  expect((await authenticateAgentApiKey(newApiKey, repository)).computerId).toBe("computer-a");
});

test("another Computer cannot send with or revoke an Agent API key", async () => {
  const repository = new MemoryAgentApiKeys();
  const apiKey = await createAgentApiKey({
    agentId: "agent-a",
    workspaceId: "workspace-a",
    ownerId: "owner-a",
    computerId: "computer-a",
    repository,
  });
  const record = await authenticateAgentApiKey(apiKey, repository);

  expect(
    isAgentApiKeyBoundToComputer(record, {
      workspaceId: "workspace-a",
      userId: "owner-a",
      computerId: "computer-b",
    }),
  ).toBeFalse();
});
