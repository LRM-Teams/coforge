import type { PrismaClient } from "../../../../generated/client";
import type { CodeAgentModelCatalog, RuntimeMetadata } from "@coforge/protocol";

export class PrismaComputerRuntimeRepository {
  constructor(private readonly db: PrismaClient) {}

  async replace(
    scope: { workspaceId: string; computerId: string },
    runtimes: RuntimeMetadata[],
    catalogs: CodeAgentModelCatalog[],
  ) {
    await this.db.$transaction(async (transaction) => {
      const connection = await transaction.workspaceComputer.findUnique({
        where: {
          workspaceId_computerId: {
            workspaceId: scope.workspaceId,
            computerId: scope.computerId,
          },
        },
        select: { id: true },
      });
      if (!connection) throw new Error("Workspace Computer connection does not exist");
      await transaction.computerRuntime.deleteMany({ where: { computerId: scope.computerId } });
      await transaction.computerModelCatalog.deleteMany({
        where: { computerId: scope.computerId },
      });
      if (runtimes.length)
        await transaction.computerRuntime.createMany({
          data: runtimes.map((runtime) => ({
            computerId: scope.computerId,
            provider: runtime.provider,
            version: runtime.version,
            displayName: runtime.displayName,
          })),
        });
      if (catalogs.length)
        await transaction.computerModelCatalog.createMany({
          data: catalogs.map((catalog) => ({
            computerId: scope.computerId,
            provider: catalog.provider,
            models: catalog.models,
          })),
        });
    });
  }
}
