import type { PrismaClient } from "#src/generated/prisma/client";
import type {
  DaemonApiKeyRecord,
  DaemonApiKeyRepository,
} from "#src/server/auth/daemon-api-key.server";

export class PrismaDaemonApiKeyRepository implements DaemonApiKeyRepository {
  constructor(private readonly db: PrismaClient) {}

  async replaceActive(record: DaemonApiKeyRecord): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "computers" WHERE "id" = ${record.computerId}::uuid FOR UPDATE`;
      await tx.daemonApiKey.updateMany({
        where: {
          computerId: record.computerId,
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      });
      await tx.daemonApiKey.create({ data: record });
    });
  }

  async findByHash(hash: string): Promise<DaemonApiKeyRecord | undefined> {
    return (
      (await this.db.daemonApiKey.findUnique({
        where: { apiKeyHash: hash },
      })) ?? undefined
    );
  }

  async markUsed(id: string, at: Date): Promise<void> {
    await this.db.daemonApiKey.update({
      where: { id },
      data: { lastUsedAt: at },
    });
  }
}
