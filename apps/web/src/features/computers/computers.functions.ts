import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import type { CodeAgentModelMetadata, RuntimeProvider } from "@coforge/protocol";
import { requireBrowserUser } from "../../server/auth/require-user.server";
import { getDatabaseClient } from "../../server/db/client.server";

export const listComputers = createServerFn({ method: "GET" }).handler(async () => {
  const user = requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
  const db = getDatabaseClient();
  if (!db) throw new Error("Computer persistence is unavailable");
  const membership = await db.workspaceMembership.findFirst({
    where: { userId: user.id },
    select: { workspaceId: true },
    orderBy: [{ workspace: { createdAt: "asc" } }, { workspaceId: "asc" }],
  });
  if (!membership) throw new Error("No Workspace membership exists for the authenticated user");
  return db.workspaceComputer
    .findMany({
      where: { workspaceId: membership.workspaceId },
      select: {
        computer: {
          select: {
            id: true,
            machineId: true,
            runtimes: {
              where: { provider: { not: "pi" } },
              select: { provider: true, version: true, observedAt: true },
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
