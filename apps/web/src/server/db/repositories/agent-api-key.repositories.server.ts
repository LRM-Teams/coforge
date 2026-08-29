import type { PrismaClient } from "../../../../generated/client";
import type { AgentApiKeyRecord, AgentApiKeyRepository } from "../../agents/agent-api-key.server";

export class PrismaAgentApiKeyRepository implements AgentApiKeyRepository {
  constructor(private readonly db: PrismaClient) {}

  async replaceActive(record: AgentApiKeyRecord): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Agent" WHERE "id" = ${record.agentId}::uuid FOR UPDATE`;
      await tx.agentApiKey.updateMany({
        where: {
          agentId: record.agentId,
          workspaceId: record.workspaceId,
          ownerId: record.ownerId,
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      });
      await tx.agentApiKey.create({ data: record });
    });
  }

  async findByHash(hash: string): Promise<AgentApiKeyRecord | undefined> {
    return (await this.db.agentApiKey.findUnique({ where: { apiKeyHash: hash } })) ?? undefined;
  }

  async revoke(id: string): Promise<void> {
    await this.db.agentApiKey.updateMany({ where: { id }, data: { revokedAt: new Date() } });
  }
}
