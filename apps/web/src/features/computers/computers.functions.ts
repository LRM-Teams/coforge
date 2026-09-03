import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import type { CodeAgentModelMetadata, RuntimeProvider } from "@coforge/protocol";
import { requireBrowserUser } from "../../server/auth/require-user.server";
import { getDatabaseClient } from "../../server/db/client.server";
import {
  createCentrifugoServerApi,
  createUsageScan,
} from "../../server/centrifugo/server-api.server";
import { getUsageCache } from "../../server/centrifugo/usage-cache.server";
import { getComputerStatus } from "../../server/centrifugo/computer-status.server";
import { workspaceIdForUser } from "../../server/workspaces/enrollment.server";

export const scanUsage = createServerFn({ method: "POST" })
  .validator((data: { computerId: string; provider: RuntimeProvider }) => data)
  .handler(async ({ data }) => {
    const user = requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
    const db = getDatabaseClient();
    if (!db) throw new Error("Computer persistence is unavailable");
    const connection = await db.workspaceComputer.findFirst({
      where: { computerId: data.computerId, workspace: { members: { some: { userId: user.id } } } },
      select: {
        workspaceId: true,
        computerId: true,
        computer: {
          select: { runtimes: { where: { provider: data.provider }, select: { provider: true } } },
        },
      },
    });
    if (!connection || !connection.computer.runtimes.length)
      throw new Error("runtime is not available");
    const scanId = await createUsageScan(createCentrifugoServerApi(), {
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      provider: data.provider,
    });
    return { scanId, status: "pending" as const };
  });

export const readUsage = createServerFn({ method: "GET" })
  .validator((data: { computerId: string; provider: RuntimeProvider }) => data)
  .handler(async ({ data }) => {
    const user = requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
    const db = getDatabaseClient();
    if (!db) throw new Error("Computer persistence is unavailable");
    const connection = await db.workspaceComputer.findFirst({
      where: { computerId: data.computerId, workspace: { members: { some: { userId: user.id } } } },
      select: { workspaceId: true },
    });
    if (!connection) throw new Error("computer is not available");
    const record = await getUsageCache().get({
      workspaceId: connection.workspaceId,
      computerId: data.computerId,
      provider: data.provider,
    });
    return record;
  });

export const listComputers = createServerFn({ method: "GET" }).handler(async () => {
  const user = requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
  const db = getDatabaseClient();
  if (!db) throw new Error("Computer persistence is unavailable");
  const workspaceId = await workspaceIdForUser(db, user.id);
  return db.workspaceComputer
    .findMany({
      where: { workspaceId },
      select: {
        computer: {
          select: {
            id: true,
            machineId: true,
            runtimes: {
              where: { provider: { not: "pi" } },
              select: { provider: true, version: true, displayName: true, observedAt: true },
              orderBy: { provider: "asc" },
            },
            modelCatalogs: {
              select: { provider: true, models: true, observedAt: true },
              orderBy: { provider: "asc" },
            },
          },
        },
      },
      orderBy: { createdAt: "asc" },
    })
    .then((connections) =>
      connections.map(({ computer }) => ({
        ...computer,
        online: getComputerStatus(workspaceId, computer.id).online,
        runtimes: computer.runtimes.map((runtime) => ({
          ...runtime,
          provider: runtimeProvider(runtime.provider),
        })),
        modelCatalogs: computer.modelCatalogs
          .map((catalog) => ({
            provider: catalog.provider as RuntimeProvider,
            models: modelMetadata(catalog.models),
            observedAt: catalog.observedAt,
          }))
          .filter((catalog) => catalog.models !== undefined)
          .map((catalog) => ({ ...catalog, models: catalog.models! })),
      })),
    );
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
