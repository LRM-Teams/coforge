import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export type AgentApiKeyRecord = {
  id: string;
  apiKeyHash: string;
  agentId: string;
  workspaceId: string;
  ownerId: string;
  computerId: string;
  revokedAt: Date | null;
  disabledAt: Date | null;
};

const AGENT_API_KEY = /^sk_agent_[A-Za-z0-9_-]{43}$/;

export interface AgentApiKeyRepository {
  replaceActive(record: AgentApiKeyRecord): Promise<void>;
  findByHash(hash: string): Promise<AgentApiKeyRecord | undefined>;
  revoke(id: string): Promise<void>;
}

export function isAgentApiKeyBoundToComputer(
  record: Pick<AgentApiKeyRecord, "workspaceId" | "computerId">,
  daemon: { workspaceId: string; computerId: string },
): boolean {
  return record.workspaceId === daemon.workspaceId && record.computerId === daemon.computerId;
}

export function hashAgentApiKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createAgentApiKey(input: {
  agentId: string;
  workspaceId: string;
  ownerId: string;
  computerId: string;
  repository: AgentApiKeyRepository;
}): Promise<string> {
  const apiKey = `sk_agent_${randomBytes(32).toString("base64url")}`;
  return input.repository
    .replaceActive({
      id: crypto.randomUUID(),
      apiKeyHash: hashAgentApiKey(apiKey),
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      ownerId: input.ownerId,
      computerId: input.computerId,
      revokedAt: null,
      disabledAt: null,
    })
    .then(() => apiKey);
}

export async function authenticateAgentApiKey(
  apiKey: string,
  repository: AgentApiKeyRepository,
): Promise<AgentApiKeyRecord> {
  if (!AGENT_API_KEY.test(apiKey)) throw new Error("invalid Agent API key");
  const actual = Buffer.from(hashAgentApiKey(apiKey));
  const record = await repository.findByHash(actual.toString());
  if (!record || record.revokedAt || record.disabledAt) throw new Error("invalid Agent API key");
  const expected = Buffer.from(record.apiKeyHash);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    throw new Error("invalid Agent API key");
  return record;
}

export async function findAgentApiKey(
  apiKey: string,
  repository: AgentApiKeyRepository,
): Promise<AgentApiKeyRecord> {
  if (!AGENT_API_KEY.test(apiKey)) throw new Error("invalid Agent API key");
  const actual = Buffer.from(hashAgentApiKey(apiKey));
  const record = await repository.findByHash(actual.toString());
  if (!record) throw new Error("invalid Agent API key");
  const expected = Buffer.from(record.apiKeyHash);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    throw new Error("invalid Agent API key");
  return record;
}
