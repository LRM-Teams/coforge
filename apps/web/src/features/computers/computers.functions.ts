import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import type { CodeAgentModelMetadata, RuntimeProvider } from "@coforge/protocol";
import {
  readUsageInputSchema,
  scanUsageInputSchema,
  setRuntimeVisibilityInputSchema,
} from "./computer.schemas";
import { requireBrowserUser } from "../../server/auth/require-user.server";
import { getDatabaseClient } from "../../server/db/client.server";
import {
  createCentrifugoServerApi,
  createUsageScan,
} from "../../server/centrifugo/server-api.server";
import { getUsageCache } from "../../server/centrifugo/usage-cache.server";
import { getComputerStatus } from "../../server/centrifugo/computer-status.server";
import { requireWorkspaceIdForRequest } from "../../server/workspaces/selection.server";
import { ComputerRuntimeVisibility } from "../../server/computers/computer-runtime-visibility.server";
import { PrismaComputerRuntimeRepository } from "../../server/db/repositories/computer-runtime.repositories.server";

function runtimeVisibility() {
  const db = getDatabaseClient();
  if (!db) throw new Error("Computer persistence is unavailable");
  return { db, visibility: new ComputerRuntimeVisibility(new PrismaComputerRuntimeRepository(db)) };
}

export const scanUsage = createServerFn({ method: "POST" })
  .validator(scanUsageInputSchema)
  .handler(async ({ data }) => {
    const user = requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
    const { db, visibility } = runtimeVisibility();
    const workspaceId = await requireWorkspaceIdForRequest(db, user.id);
    if (
      !(await visibility.isOwner({ workspaceId, userId: user.id }, data.computerId, data.provider))
    )
      throw new Error("runtime is not available");
    const scanId = await createUsageScan(createCentrifugoServerApi(), {
      workspaceId,
      computerId: data.computerId,
      provider: data.provider,
    });
    return { scanId, status: "pending" as const };
  });

export const readUsage = createServerFn({ method: "GET" })
  .validator(readUsageInputSchema)
  .handler(async ({ data }) => {
    const user = requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
    const { db, visibility } = runtimeVisibility();
    const workspaceId = await requireWorkspaceIdForRequest(db, user.id);
    if (
      !(await visibility.isOwner({ workspaceId, userId: user.id }, data.computerId, data.provider))
    )
      throw new Error("runtime is not available");
    const record = await getUsageCache().get({
      workspaceId,
      computerId: data.computerId,
      provider: data.provider,
    });
    return record;
  });

export const listComputers = createServerFn({ method: "GET" }).handler(async () => {
  const user = requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
  const { db, visibility } = runtimeVisibility();
  const workspaceId = await requireWorkspaceIdForRequest(db, user.id);
  const [connections, runtimes] = await Promise.all([
    db.workspaceComputer.findMany({
      where: { workspaceId },
      select: {
        createdAt: true,
        computer: {
          select: {
            id: true,
            machineId: true,
            kind: true,
            ownerId: true,
            modelCatalogs: {
              select: { provider: true, models: true, observedAt: true },
              orderBy: { provider: "asc" },
            },
          },
        },
      },
      orderBy: { createdAt: "asc" },
    }),
    visibility.list({ workspaceId, userId: user.id }),
  ]);
  return connections.map(({ computer, createdAt }) => {
    const computerRuntimes = runtimes.filter((runtime) => runtime.computerId === computer.id);
    const visibleProviders = new Set(computerRuntimes.map((runtime) => runtime.provider));
    return {
      id: computer.id,
      machineId: computer.machineId,
      kind: computer.kind,
      connectedAt: createdAt,
      ownedByCurrentUser: computer.ownerId === user.id,
      online: getComputerStatus(workspaceId, computer.id).online,
      runtimes: computerRuntimes.map(({ ownerId: _ownerId, ...runtime }) => runtime),
      modelCatalogs: computer.modelCatalogs
        .filter(
          (catalog) =>
            catalog.provider === "pi" || visibleProviders.has(runtimeProvider(catalog.provider)),
        )
        .map((catalog) => ({
          provider: runtimeProvider(catalog.provider),
          models: modelMetadata(catalog.models),
          observedAt: catalog.observedAt,
        }))
        .filter((catalog) => catalog.models !== undefined)
        .map((catalog) => ({ ...catalog, models: catalog.models! })),
    };
  });
});

export const setRuntimeVisibility = createServerFn({ method: "POST" })
  .validator(setRuntimeVisibilityInputSchema)
  .handler(async ({ data }) => {
    const user = requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
    const { db, visibility } = runtimeVisibility();
    const workspaceId = await requireWorkspaceIdForRequest(db, user.id);
    return visibility.setPublic({ workspaceId, userId: user.id }, data.runtimeId, data.isPublic);
  });

function modelMetadata(value: unknown): CodeAgentModelMetadata[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const models: CodeAgentModelMetadata[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
    const id = Reflect.get(candidate, "id");
    const displayName = Reflect.get(candidate, "displayName");
    const description = Reflect.get(candidate, "description");
    const modelProvider = Reflect.get(candidate, "modelProvider");
    const reasoningEfforts = Reflect.get(candidate, "reasoningEfforts");
    const defaultReasoning = Reflect.get(candidate, "defaultReasoning");
    const recommended = Reflect.get(candidate, "recommended");
    if (
      typeof id !== "string" ||
      typeof displayName !== "string" ||
      typeof description !== "string" ||
      typeof modelProvider !== "string" ||
      !Array.isArray(reasoningEfforts) ||
      !reasoningEfforts.every((effort) => typeof effort === "string") ||
      typeof defaultReasoning !== "string" ||
      typeof recommended !== "boolean"
    )
      return undefined;
    models.push({
      id,
      displayName,
      description,
      modelProvider,
      reasoningEfforts,
      defaultReasoning,
      recommended,
    });
  }
  return models;
}

function runtimeProvider(value: string): RuntimeProvider {
  if (value === "codex" || value === "claude-code" || value === "pi") return value;
  throw new Error("Computer reported an unknown runtime provider");
}
