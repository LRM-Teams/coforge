import type { PrismaClient } from "#src/generated/prisma/client";
import {
  requireRuntimeProvider,
  type CodeAgentModelCatalog,
  type RuntimeMetadata,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";
import type {
  ComputerRuntimeRecord,
  ComputerRuntimeVisibilityRepository,
} from "#src/server/computers/computer-runtime-visibility.server";

const runtimeShape = {
  id: true,
  workspaceId: true,
  computerId: true,
  provider: true,
  version: true,
  displayName: true,
  observedAt: true,
  isPublic: true,
  computer: { select: { ownerId: true } },
} as const;

function runtimeProvider(value: string): RuntimeProvider {
  return requireRuntimeProvider(value, "Computer runtime has an invalid provider");
}

function mapRuntime(runtime: {
  id: string;
  workspaceId: string;
  computerId: string;
  provider: string;
  version: string;
  displayName: string;
  observedAt: Date;
  isPublic: boolean;
  computer: { ownerId: string };
}): ComputerRuntimeRecord {
  const { computer, ...record } = runtime;
  return {
    ...record,
    ownerId: computer.ownerId,
    provider: runtimeProvider(record.provider),
  };
}

export class PrismaComputerRuntimeRepository implements ComputerRuntimeVisibilityRepository {
  constructor(private readonly db: PrismaClient) {}

  async listInWorkspace(workspaceId: string) {
    const runtimes = await this.db.computerRuntime.findMany({
      where: { workspaceId },
      select: runtimeShape,
      orderBy: [{ computerId: "asc" }, { provider: "asc" }],
    });
    return runtimes.map(mapRuntime);
  }

  async findInWorkspace(workspaceId: string, computerId: string, provider: RuntimeProvider) {
    const runtime = await this.db.computerRuntime.findFirst({
      where: { workspaceId, computerId, provider },
      select: runtimeShape,
    });
    return runtime ? mapRuntime(runtime) : undefined;
  }

  async findByIdInWorkspace(workspaceId: string, runtimeId: string) {
    const runtime = await this.db.computerRuntime.findFirst({
      where: { id: runtimeId, workspaceId },
      select: runtimeShape,
    });
    return runtime ? mapRuntime(runtime) : undefined;
  }

  setPublic(runtimeId: string, isPublic: boolean) {
    return this.db.computerRuntime.update({
      where: { id: runtimeId },
      data: { isPublic },
    });
  }

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
      const providers = runtimes.map((runtime) => runtime.provider);
      await transaction.computerRuntime.deleteMany({
        where: {
          workspaceId: scope.workspaceId,
          computerId: scope.computerId,
          ...(providers.length ? { provider: { notIn: providers } } : {}),
        },
      });
      // A provider that is still installed but reported no catalog this round (for example its
      // model CLI probe failed) keeps its last-known models: only providers that are no longer an
      // installed runtime are dropped. This keeps one failing provider from clearing every
      // model catalog on the Computer.
      await transaction.computerModelCatalog.deleteMany({
        where: {
          workspaceId: scope.workspaceId,
          computerId: scope.computerId,
          ...(providers.length ? { provider: { notIn: providers } } : {}),
        },
      });
      for (const runtime of runtimes) {
        await transaction.computerRuntime.upsert({
          where: {
            workspaceId_computerId_provider: {
              workspaceId: scope.workspaceId,
              computerId: scope.computerId,
              provider: runtime.provider,
            },
          },
          create: {
            workspaceId: scope.workspaceId,
            computerId: scope.computerId,
            provider: runtime.provider,
            version: runtime.version,
            displayName: runtime.displayName,
          },
          update: {
            version: runtime.version,
            displayName: runtime.displayName,
            observedAt: new Date(),
          },
        });
      }
      for (const catalog of catalogs) {
        await transaction.computerModelCatalog.upsert({
          where: {
            workspaceId_computerId_provider: {
              workspaceId: scope.workspaceId,
              computerId: scope.computerId,
              provider: catalog.provider,
            },
          },
          create: {
            workspaceId: scope.workspaceId,
            computerId: scope.computerId,
            provider: catalog.provider,
            models: catalog.models,
          },
          update: { models: catalog.models, observedAt: new Date() },
        });
      }
    });
  }
}
