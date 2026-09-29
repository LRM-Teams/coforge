import { RedisClient } from "bun";
import type { PrismaClient } from "#src/generated/prisma/client";
import { getDatabaseClient } from "../db/client.server";
import { PrismaOpenVikingBindingStore } from "../db/repositories/openviking-binding.repositories.server";
import { PrismaWorkspaceMemoryAdmissionStore } from "../db/repositories/workspace-memory-admission.repositories.server";
import { PrismaWorkspaceMemoryCatalog } from "../db/repositories/workspace-memory-catalog.repositories.server";
import { PrismaWorkspaceMemoryIdentityDirectory } from "../db/repositories/workspace-memory-identity.repositories.server";
import { PrismaWorkspaceMemoryProfileStore } from "../db/repositories/workspace-memory-profile.repositories.server";
import { createFakeOpenVikingProvisioner } from "../openviking/stores";
import type { OpenVikingTypedSessionExtract } from "../openviking/typed-session-extract.server";
import { createAdmissionDispatcher, createOpenVikingNativeSessionSink } from "./dispatch";
import { createOpenVikingAdmittedDeliverySink } from "./ov-sink.server";
import { createWorkspaceMemoryProfileReconciler } from "./reconciler";
import { createWorkspaceMemoryProfiles } from "./profiles";
import { createWorkspaceMemorySwitching } from "./switching";
import { isOpenVikingPrototypeEnabled } from "./prototype-gate";
import {
  createProductionMemoryRuntimeProvisioner,
  createPrototypeMemoryRuntimeReadiness,
} from "./runtime-provisioner";
import {
  WORKSPACE_MEMORY_QUIET_WINDOW_MS,
  createWorkspaceMemoryAdmissionSweep,
  type WorkspaceMemoryAdmissionSweep,
  type WorkspaceMemorySweepLock,
} from "./sweep";

export const WORKSPACE_MEMORY_SWEEP_INTERVAL_MS = 30_000;
const SWEEP_LOCK_TTL_MS = 25_000;
const SWEEP_LOCK_KEY = "coforge:workspace-memory:admission-sweep:lock";

type LockRedisPort = {
  set(key: string, value: string, ...options: Array<string | number>): Promise<unknown>;
};

export class RedisWorkspaceMemorySweepLock implements WorkspaceMemorySweepLock {
  constructor(private readonly redis: LockRedisPort) {}

  async acquire(instanceId: string): Promise<boolean> {
    const result = await this.redis.set(SWEEP_LOCK_KEY, instanceId, "NX", "PX", SWEEP_LOCK_TTL_MS);
    return result === "OK";
  }
}

export class WorkspaceMemoryLifecycle {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly sweep: WorkspaceMemoryAdmissionSweep,
    readonly switching?: ReturnType<typeof createWorkspaceMemorySwitching>,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), WORKSPACE_MEMORY_SWEEP_INTERVAL_MS);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  tick(): Promise<void> {
    return this.sweep.tick();
  }
}

export function composeWorkspaceMemoryLifecycle(input: {
  db: PrismaClient;
  lock: WorkspaceMemorySweepLock;
  now?: () => Date;
  openvikingSessions?: OpenVikingTypedSessionExtract;
  openvikingSinkOwner?: string;
}): WorkspaceMemoryLifecycle {
  const profiles = new PrismaWorkspaceMemoryProfileStore(input.db);
  const bindings = new PrismaOpenVikingBindingStore(input.db);
  const admission = new PrismaWorkspaceMemoryAdmissionStore(input.db);
  const catalog = new PrismaWorkspaceMemoryCatalog(input.db);
  const identities = new PrismaWorkspaceMemoryIdentityDirectory(input.db);
  const provisioner = createProductionMemoryRuntimeProvisioner({
    openviking: createFakeOpenVikingProvisioner(),
    bindings,
    identities,
    mappedIdentities: identities,
    readiness: createPrototypeMemoryRuntimeReadiness(),
  });
  const profileApi = createWorkspaceMemoryProfiles({
    store: profiles,
    gate: { prototypeEnabled: isOpenVikingPrototypeEnabled(Bun.env) },
  });
  const reconciler = createWorkspaceMemoryProfileReconciler({ store: profiles, provisioner });
  const dispatcher = createAdmissionDispatcher({
    admission,
    sinks: {
      openviking:
        input.openvikingSessions && input.openvikingSinkOwner
          ? createOpenVikingAdmittedDeliverySink({
              sessions: input.openvikingSessions,
              owner: input.openvikingSinkOwner,
            })
          : createOpenVikingNativeSessionSink(),
    },
  });
  const switching = createWorkspaceMemorySwitching({
    profiles: profileApi,
    reconciler,
    dispatcher,
    getBinding: (workspaceId) => bindings.get(workspaceId),
    snapshotRuntimes: async (workspaceId) => {
      const binding = await bindings.get(workspaceId);
      return {
        openviking: binding
          ? {
              workspaceId,
              generation: binding.generation,
              kind: "openviking",
              resourceId: binding.accountId,
            }
          : null,
      };
    },
  });
  return new WorkspaceMemoryLifecycle(
    createWorkspaceMemoryAdmissionSweep({
      profiles,
      catalog,
      admission,
      dispatcher,
      reconciler,
      lock: input.lock,
      now: input.now,
      quietAfterMs: WORKSPACE_MEMORY_QUIET_WINDOW_MS,
    }),
    switching,
  );
}

let singleton: WorkspaceMemoryLifecycle | undefined;

export function ensureWorkspaceMemoryLifecycle(): WorkspaceMemoryLifecycle | undefined {
  const redisUrl = Bun.env.REDIS_URL;
  const db = getDatabaseClient();
  if (!redisUrl || !db) return undefined;
  singleton ??= composeWorkspaceMemoryLifecycle({
    db,
    lock: new RedisWorkspaceMemorySweepLock(new RedisClient(redisUrl)),
  });
  singleton.start();
  return singleton;
}
