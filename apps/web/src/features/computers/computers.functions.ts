import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import {
  isValidReleaseVersion,
  type CodeAgentModelMetadata,
  parseRuntimeProvider,
  type RuntimeProvider,
} from "@coforge/protocol";
import {
  computerIdInputSchema,
  readRestartStatusInputSchema,
  readUsageInputSchema,
  restartComputerInputSchema,
  scanUsageInputSchema,
  setRuntimeVisibilityInputSchema,
  updateComputerDisplayNameInputSchema,
} from "./computer.schemas";
import { requireBrowserUser } from "../../server/auth/require-user.server";
import { getDatabaseClient } from "../../server/db/client.server";
import {
  createCentrifugoServerApi,
  createUsageScan,
} from "../../server/centrifugo/server-api.server";
import { getUsageCache } from "../../server/centrifugo/usage-cache.server";
import { getComputerStatusCache } from "../../server/centrifugo/computer-status.server";
import { requireWorkspaceIdForRequest } from "../../server/workspaces/selection.server";
import { ComputerRuntimeVisibility } from "../../server/computers/computer-runtime-visibility.server";
import { PrismaComputerRuntimeRepository } from "../../server/db/repositories/computer-runtime.repositories.server";
import { RestartComputer } from "../../server/computers/restart-computer.server";
import { getComputerRestartStore } from "../../server/computers/computer-restart-store.server";
import { getComputerUpgradeStore } from "../../server/computers/computer-upgrade-store.server";
import { resolveReleaseFeedUrl } from "../../server/install/install-script.server";
import { encodeComputerUpgradeIntent } from "@coforge/protocol";
import { browserScope } from "../../server/auth/browser-scope.server";

const computerUnavailable = () => new Error("Computer persistence is unavailable");

export const restartComputer = createServerFn({ method: "POST" })
  .validator(restartComputerInputSchema)
  .handler(async ({ data }) => {
    const { user, db, workspaceId } = await browserScope(computerUnavailable);
    return new RestartComputer(
      {
        canRestart: async (scope) =>
          Boolean(
            await db.workspaceComputer.findFirst({
              where: {
                workspaceId: scope.workspaceId,
                computerId: scope.computerId,
                workspace: { memberships: { some: { userId: scope.userId } } },
              },
              select: { id: true },
            }),
          ),
      },
      createCentrifugoServerApi(),
      getComputerRestartStore(),
    ).execute({ userId: user.id, workspaceId }, data);
  });

export const readComputerRestartStatus = createServerFn({ method: "GET" })
  .validator(readRestartStatusInputSchema)
  .handler(async ({ data }) => {
    const { user, db, workspaceId } = await browserScope(computerUnavailable);
    const connection = await db.workspaceComputer.findFirst({
      where: {
        workspaceId,
        computerId: data.computerId,
        workspace: { memberships: { some: { userId: user.id } } },
      },
      select: { id: true },
    });
    if (!connection) throw new Error("Computer is not available");
    const status = await getComputerRestartStore().status(
      { workspaceId, computerId: data.computerId },
      data.requestId,
    );
    if (!status) throw new Error("Restart request is not available");
    return status;
  });

function runtimeVisibility() {
  const db = getDatabaseClient();
  if (!db) throw new Error("Computer persistence is unavailable");
  return {
    db,
    visibility: new ComputerRuntimeVisibility(new PrismaComputerRuntimeRepository(db)),
  };
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
  const computerStatus = getComputerStatusCache();
  const [connections, runtimes] = await Promise.all([
    db.workspaceComputer.findMany({
      where: { workspaceId },
      select: {
        createdAt: true,
        computer: {
          select: {
            id: true,
            name: true,
            displayName: true,
            kind: true,
            ownerId: true,
            computerVersion: true,
            platform: true,
            osVersion: true,
            owner: { select: { username: true, displayName: true, avatarObjectKey: true } },
          },
        },
      },
      orderBy: { createdAt: "asc" },
    }),
    visibility.list({ workspaceId, userId: user.id }),
  ]);
  return Promise.all(
    connections.map(async ({ computer, createdAt }) => {
      const computerRuntimes = runtimes.filter((runtime) => runtime.computerId === computer.id);
      return {
        id: computer.id,
        name: computer.name,
        displayName: computer.displayName,
        kind: computer.kind,
        computerVersion: computer.computerVersion,
        platform: computer.platform,
        osVersion: computer.osVersion,
        creator: {
          username: computer.owner.username,
          displayName: computer.owner.displayName,
          avatarUrl: computer.owner.avatarObjectKey
            ? `/api/computers/${computer.id}/creator-avatar?workspaceId=${workspaceId}`
            : null,
        },
        connectedAt: createdAt,
        ownedByCurrentUser: computer.ownerId === user.id,
        online: await computerStatus.get({
          workspaceId,
          computerId: computer.id,
        }),
        runtimes: computerRuntimes.map(({ ownerId: _ownerId, ...runtime }) => runtime),
      };
    }),
  );
});

export const readComputerUpgradeStatus = createServerFn({ method: "GET" })
  .validator(readRestartStatusInputSchema)
  .handler(async ({ data }) => {
    const { user, db, workspaceId } = await browserScope(computerUnavailable);
    const connection = await db.workspaceComputer.findFirst({
      where: {
        workspaceId,
        computerId: data.computerId,
        workspace: { memberships: { some: { userId: user.id } } },
      },
      select: { id: true },
    });
    if (!connection) throw new Error("Computer is not available");
    const status = await getComputerUpgradeStore().status(
      { workspaceId, computerId: data.computerId },
      data.requestId,
    );
    if (!status) throw new Error("Upgrade request is not available");
    return status;
  });

export const upgradeComputer = createServerFn({ method: "POST" })
  .validator(restartComputerInputSchema)
  .handler(async ({ data }) => {
    const { user, db, workspaceId } = await browserScope(computerUnavailable);
    const computer = await db.computer.findFirst({
      where: { id: data.computerId },
      select: { ownerId: true },
    });
    if (!computer || computer.ownerId !== user.id) throw new Error("Computer is not available");
    const connection = await db.workspaceComputer.findFirst({
      where: { workspaceId, computerId: data.computerId },
      select: { id: true },
    });
    if (!connection) throw new Error("Computer is not available");
    const feedUrl = resolveReleaseFeedUrl();
    if (!feedUrl) throw new Error("Computer release feed is unavailable");
    const response = await fetch(`${feedUrl}/latest`, { signal: AbortSignal.timeout(3_000) });
    const expectedVersion = response.ok ? (await response.text()).trim() : "";
    if (!isValidReleaseVersion(expectedVersion))
      throw new Error("Computer release feed returned an invalid version");
    const store = getComputerUpgradeStore();
    const registered = await store.begin(
      { workspaceId, computerId: data.computerId },
      data.requestId,
      expectedVersion,
    );
    if (!registered.created) return registered.status;
    try {
      await createCentrifugoServerApi().publish(
        `daemon:${workspaceId}:${data.computerId}`,
        encodeComputerUpgradeIntent({
          protocolMajor: 1,
          requestId: data.requestId,
          workspaceId,
          computerId: data.computerId,
          target: "latest",
          expectedVersion,
        }),
      );
      return registered.status;
    } catch (error) {
      await store.publicationFailed({ workspaceId, computerId: data.computerId }, data.requestId);
      throw error;
    }
  });

export const getLatestComputerVersion = createServerFn({ method: "GET" }).handler(async () => {
  const feedUrl = resolveReleaseFeedUrl();
  if (!feedUrl) return null;

  try {
    const response = await fetch(`${feedUrl}/latest`, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) return null;
    const version = (await response.text()).trim();
    return isValidReleaseVersion(version) ? version : null;
  } catch {
    return null;
  }
});

export const getComputerRuntimeCatalog = createServerFn({ method: "GET" })
  .validator(computerIdInputSchema)
  .handler(async ({ data }) => {
    const user = requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
    const { db, visibility } = runtimeVisibility();
    const workspaceId = await requireWorkspaceIdForRequest(db, user.id);
    const [connection, runtimes] = await Promise.all([
      db.workspaceComputer.findUnique({
        where: {
          workspaceId_computerId: { workspaceId, computerId: data.computerId },
        },
        select: {
          computer: {
            select: {
              modelCatalogs: {
                where: { workspaceId },
                select: { provider: true, models: true, observedAt: true },
                orderBy: { provider: "asc" },
              },
            },
          },
        },
      }),
      visibility.list({ workspaceId, userId: user.id }),
    ]);
    if (!connection) throw new Error("Computer is not available");
    const visibleProviders = new Set(
      runtimes
        .filter((runtime) => runtime.computerId === data.computerId)
        .map((runtime) => runtime.provider),
    );
    return connection.computer.modelCatalogs
      .filter((catalog) => visibleProviders.has(runtimeProvider(catalog.provider)))
      .map((catalog) => ({
        provider: runtimeProvider(catalog.provider),
        models: modelMetadata(catalog.models),
        observedAt: catalog.observedAt,
      }))
      .filter((catalog) => catalog.models !== undefined)
      .map((catalog) => ({ ...catalog, models: catalog.models! }));
  });

export const setRuntimeVisibility = createServerFn({ method: "POST" })
  .validator(setRuntimeVisibilityInputSchema)
  .handler(async ({ data }) => {
    const user = requireBrowserUser(getRequest().headers.get("cookie") ?? undefined);
    const { db, visibility } = runtimeVisibility();
    const workspaceId = await requireWorkspaceIdForRequest(db, user.id);
    return visibility.setPublic({ workspaceId, userId: user.id }, data.runtimeId, data.isPublic);
  });

export const updateComputerDisplayName = createServerFn({ method: "POST" })
  .validator(updateComputerDisplayNameInputSchema)
  .handler(async ({ data }) => {
    const { user, db, workspaceId } = await browserScope(computerUnavailable);
    const result = await db.computer.updateMany({
      where: {
        id: data.computerId,
        ownerId: user.id,
        workspaces: { some: { workspaceId } },
      },
      data: { displayName: data.displayName },
    });
    if (result.count !== 1) throw new Error("Computer is not available");
    return { displayName: data.displayName };
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
  const provider = parseRuntimeProvider(value);
  if (!provider) throw new Error("Computer reported an unknown runtime provider");
  return provider;
}
