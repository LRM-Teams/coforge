import { createServerFn } from "@tanstack/react-start";
import {
  encodeDaemonRuntimeProviderModelRefreshRequest,
  isValidReleaseVersion,
  parseRuntimeProvider,
  WORKSPACE_PROTOCOL_MAJOR,
  type CodeAgentModelMetadata,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";
import { AppError } from "#src/lib/app-error";

import {
  computerIdInputSchema,
  readRestartStatusInputSchema,
  readUsageInputSchema,
  restartComputerInputSchema,
  scanUsageInputSchema,
  setRuntimeVisibilityInputSchema,
  updateComputerDisplayNameInputSchema,
} from "./computer.schemas";
import {
  workspaceUserMiddleware,
  type WorkspaceUserContext,
} from "#src/features/auth/function-auth";
import {
  createCentrifugoServerApi,
  createUsageScan,
  daemonControlChannel,
} from "#src/server/centrifugo/server-api.server";
import { getUsageCache } from "#src/server/centrifugo/usage-cache.server";
import { getComputerStatusCache } from "#src/server/centrifugo/computer-status.server";
import { computerCreatorAvatarUrl } from "#src/server/computers/computer-creator-avatar.server";
import { isWorkspaceMemberComputer } from "#src/server/computers/computer-membership.server";
import { ComputerRuntimeVisibility } from "#src/server/computers/computer-runtime-visibility.server";
import { PrismaComputerRuntimeRepository } from "#src/server/db/repositories/computer-runtime.repositories.server";
import { RestartComputer } from "#src/server/computers/restart-computer.server";
import { getComputerRestartStore } from "#src/server/computers/computer-restart-store.server";
import { getComputerUpgradeStore } from "#src/server/computers/computer-upgrade-store.server";
import { UpgradeComputer } from "#src/server/computers/upgrade-computer.server";
import { resolveReleaseFeedUrl } from "#src/server/install/install-script.server";

export const restartComputer = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(restartComputerInputSchema)
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    return new RestartComputer(
      {
        canRestart: (scope) => isWorkspaceMemberComputer(db, scope),
      },
      createCentrifugoServerApi(),
      getComputerRestartStore(),
    ).execute({ userId: user.id, workspaceId }, data);
  });

export const readComputerRestartStatus = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(readRestartStatusInputSchema)
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    const scope = { workspaceId, computerId: data.computerId };
    if (!(await isWorkspaceMemberComputer(db, { userId: user.id, ...scope })))
      throw new Error("Computer is not available");
    const status = await getComputerRestartStore().status(scope, data.requestId);
    if (!status) throw new Error("Restart request is not available");
    return status;
  });

function runtimeVisibility(db: WorkspaceUserContext["db"]) {
  return new ComputerRuntimeVisibility(new PrismaComputerRuntimeRepository(db));
}

export const scanUsage = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(scanUsageInputSchema)
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    const visibility = runtimeVisibility(db);
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
  .middleware([workspaceUserMiddleware])
  .validator(readUsageInputSchema)
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    const visibility = runtimeVisibility(db);
    if (
      !(await visibility.isOwner({ workspaceId, userId: user.id }, data.computerId, data.provider))
    )
      throw new Error("runtime is not available");
    return getUsageCache().read({
      workspaceId,
      computerId: data.computerId,
      provider: data.provider,
    });
  });

/** Every Computer connected to the Workspace, by identity only: what pickers and search name. */
export const listComputerNames = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context: { db, workspaceId } }) => {
    const connections = await db.workspaceComputer.findMany({
      where: { workspaceId },
      select: { computer: { select: { id: true, name: true, displayName: true, kind: true } } },
      orderBy: { createdAt: "asc" },
    });
    return connections.map(({ computer }) => computer);
  });

export const listComputers = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .handler(async ({ context }) => {
    const { user, db, workspaceId } = context;
    const visibility = runtimeVisibility(db);
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
            avatarUrl: computerCreatorAvatarUrl(
              computer.id,
              workspaceId,
              computer.owner.avatarObjectKey,
            ),
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
  .middleware([workspaceUserMiddleware])
  .validator(readRestartStatusInputSchema)
  .handler(async ({ context: { user, db, workspaceId }, data }) => {
    const scope = { workspaceId, computerId: data.computerId };
    if (!(await isWorkspaceMemberComputer(db, { userId: user.id, ...scope })))
      throw new Error("Computer is not available");
    const status = await getComputerUpgradeStore().status(scope, data.requestId);
    if (!status) throw new Error("Upgrade request is not available");
    return status;
  });

async function fetchExpectedUpgradeVersion(): Promise<string> {
  const feedUrl = resolveReleaseFeedUrl();
  if (!feedUrl) throw new AppError("RELEASE_FEED_UNAVAILABLE");
  const response = await fetch(`${feedUrl}/latest`, { signal: AbortSignal.timeout(3_000) });
  const expectedVersion = response.ok ? (await response.text()).trim() : "";
  if (!isValidReleaseVersion(expectedVersion)) throw new AppError("RELEASE_FEED_UNAVAILABLE");
  return expectedVersion;
}

export const upgradeComputer = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(restartComputerInputSchema)
  .handler(async ({ context: { user, db, workspaceId }, data }) => {
    const computer = await db.computer.findFirst({
      where: { id: data.computerId },
      select: { ownerId: true },
    });
    if (!computer || computer.ownerId !== user.id) throw new Error("Computer is not available");
    const scope = { workspaceId, computerId: data.computerId };
    const connection = await db.workspaceComputer.findFirst({
      where: scope,
      select: { id: true },
    });
    if (!connection) throw new Error("Computer is not available");
    return new UpgradeComputer(
      getComputerUpgradeStore(),
      getComputerStatusCache(),
      fetchExpectedUpgradeVersion,
      createCentrifugoServerApi(),
    ).execute({ workspaceId }, data);
  });

/** The release feed answers a version string that changes at most once per release, so a
 * short-TTL module cache keeps the Computers page's loader off the network path: the first read
 * in a window fetches, every read within the window reuses the answer. A failed fetch is also
 * cached briefly (a shorter TTL) so an unreachable feed turns into one bounded stall per window
 * instead of one on every page load. Single-instance server, so a module global is the cache. */
const VERSION_TTL_MS = 60_000;
const VERSION_FAILURE_TTL_MS = 10_000;
let versionCache: { value: string | null; at: number } | undefined;

export const getLatestComputerVersion = createServerFn({ method: "GET" }).handler(async () => {
  const feedUrl = resolveReleaseFeedUrl();
  if (!feedUrl) return null;
  return readLatestComputerVersion(feedUrl);
});

/** One feed read through the TTL cache; exported for tests (inject the fetch so no network). */
export async function readLatestComputerVersion(
  feedUrl: string,
  fetchImpl: typeof fetch = fetch,
  now = Date.now,
): Promise<string | null> {
  if (
    versionCache &&
    now() - versionCache.at <
      (versionCache.value === null ? VERSION_FAILURE_TTL_MS : VERSION_TTL_MS)
  )
    return versionCache.value;
  try {
    const response = await fetchImpl(`${feedUrl}/latest`, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) throw new Error("release feed unavailable");
    const version = (await response.text()).trim();
    const value = isValidReleaseVersion(version) ? version : null;
    versionCache = { value, at: now() };
    return value;
  } catch {
    // Feed down or unparsable: remember the miss briefly so page loads during an outage
    // skip the stall, but let the next read retry rather than pinning the failure a minute.
    versionCache = { value: null, at: now() };
    return null;
  }
}

export const getComputerRuntimeCatalog = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(computerIdInputSchema)
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    const visibility = runtimeVisibility(db);
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

/** Asks the Computer's daemon to re-run its model-catalog discovery now (the browser's model
 * selector refresh button / selector-open auto-refresh). Fire-and-forget on the wire: the daemon
 * re-reports through the ordinary `daemon:v1:provider:inventory_update` and answers via
 * `daemon:v1:provider:model_refresh_result`; the caller watches `getComputerRuntimeCatalog`'s
 * `observedAt` move to see the refresh land. Authorizes exactly like reading the catalog: the
 * Computer must belong to this Workspace. */
export const refreshComputerRuntimeCatalog = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(computerIdInputSchema)
  .handler(async ({ context, data }) => {
    const { db, workspaceId } = context;
    const connection = await db.workspaceComputer.findUnique({
      where: { workspaceId_computerId: { workspaceId, computerId: data.computerId } },
      select: { computerId: true },
    });
    if (!connection) throw new Error("Computer is not available");
    await createCentrifugoServerApi().publish(
      daemonControlChannel(workspaceId, data.computerId),
      encodeDaemonRuntimeProviderModelRefreshRequest({
        protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
        requestId: crypto.randomUUID(),
        workspaceId,
        computerId: data.computerId,
      }),
    );
    return { status: "pending" as const };
  });

export const setRuntimeVisibility = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(setRuntimeVisibilityInputSchema)
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    const visibility = runtimeVisibility(db);
    return visibility.setPublic({ workspaceId, userId: user.id }, data.runtimeId, data.isPublic);
  });

export const updateComputerDisplayName = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(updateComputerDisplayNameInputSchema)
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
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
