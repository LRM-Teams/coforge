import type { PrismaClient } from "../../../../generated/client";
import {
  RUNTIME_PROVIDER,
  type CodeAgentModelCatalog,
  type RuntimeMetadata,
  type RuntimeProvider,
} from "@coforge/protocol";
import type {
  ComputerRuntimeRecord,
  ComputerRuntimeVisibilityRepository,
} from "../../computers/computer-runtime-visibility.server";

const runtimeShape = {
  id: true,
  computerId: true,
  provider: true,
  version: true,
  displayName: true,
  observedAt: true,
  isPublic: true,
  computer: { select: { ownerId: true } },
} as const;

function runtimeProvider(value: string): RuntimeProvider {
  if (value === RUNTIME_PROVIDER.CODEX || value === RUNTIME_PROVIDER.CLAUDE_CODE) return value;
  throw new Error("Computer runtime has an invalid provider");
}

function mapRuntime(runtime: {
  id: string;
  computerId: string;
  provider: string;
  version: string;
  displayName: string;
  observedAt: Date;
  isPublic: boolean;
  computer: { ownerId: string };
}): ComputerRuntimeRecord {
  const { computer, ...record } = runtime;
  return { ...record, ownerId: computer.ownerId, provider: runtimeProvider(record.provider) };
}

export class PrismaComputerRuntimeRepository implements ComputerRuntimeVisibilityRepository {
  constructor(private readonly db: PrismaClient) {}

  async listInWorkspace(workspaceId: string) {
    const runtimes = await this.db.computerRuntime.findMany({
      where: { computer: { workspaces: { some: { workspaceId } } } },
      select: runtimeShape,
      orderBy: [{ computerId: "asc" }, { provider: "asc" }],
    });
    return runtimes.map(mapRuntime);
  }

  async findInWorkspace(workspaceId: string, computerId: string, provider: RuntimeProvider) {
    const runtime = await this.db.computerRuntime.findFirst({
      where: { computerId, provider, computer: { workspaces: { some: { workspaceId } } } },
      select: runtimeShape,
    });
    return runtime ? mapRuntime(runtime) : undefined;
  }

  async findByIdInWorkspace(workspaceId: string, runtimeId: string) {
    const runtime = await this.db.computerRuntime.findFirst({
      where: { id: runtimeId, computer: { workspaces: { some: { workspaceId } } } },
      select: runtimeShape,
    });
    return runtime ? mapRuntime(runtime) : undefined;
  }

  setPublic(runtimeId: string, isPublic: boolean) {
    return this.db.computerRuntime.update({ where: { id: runtimeId }, data: { isPublic } });
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
          computerId: scope.computerId,
          ...(providers.length ? { provider: { notIn: providers } } : {}),
        },
      });
      await transaction.computerModelCatalog.deleteMany({
        where: { computerId: scope.computerId },
      });
      for (const runtime of runtimes) {
        await transaction.computerRuntime.upsert({
          where: {
            computerId_provider: {
              computerId: scope.computerId,
              provider: runtime.provider,
            },
          },
          create: {
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
