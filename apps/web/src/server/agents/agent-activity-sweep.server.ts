import { RedisClient } from "bun";
import { redisUrlFor } from "#src/server/redis-url.server";
import { encodeAgentActivityProbe } from "@lrm/coforge-sdk/internal";

import {
  agentStatusChannel,
  agentStatusChannelForAgent,
} from "#src/features/agents/agent-status-realtime";
import { AGENT_VISIBILITY } from "#src/features/agents/agent-visibility";
import { ACTIVITY_PROBE_TIMEOUT_MS } from "#src/features/agents/activity-probe-timeout";
import {
  createCentrifugoServerApi,
  daemonControlChannel,
} from "#src/server/centrifugo/server-api.server";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { getAgentDisplay, type AgentDisplay, type Scope } from "./agent-display.server";
import { getDatabaseClient } from "#src/server/db/client.server";

/** How often `AgentActivitySweep.tick()` looks for stale busy leases. */
export const ACTIVITY_SWEEP_INTERVAL_MS = 5_000;
/** Bounds one tick's Redis and Centrifugo-publish cost regardless of fleet size. */
const SWEEP_BATCH_LIMIT = 200;
/** Shorter than the 5s interval on purpose, so a slow tick cannot overlap the next one. */
const SWEEP_LOCK_TTL_MS = 4_500;
const SWEEP_LOCK_KEY = "coforge:agent-display:activity-sweep:lock";

export interface AgentActivitySweepLock {
  /** Returns true when this instance acquired the lock for the current tick. */
  acquire(instanceId: string): Promise<boolean>;
}

type LockRedisPort = {
  set(key: string, value: string, ...options: Array<string | number>): Promise<unknown>;
};

export class RedisAgentActivitySweepLock implements AgentActivitySweepLock {
  constructor(private readonly redis: LockRedisPort) {}

  async acquire(instanceId: string): Promise<boolean> {
    const result = await this.redis.set(SWEEP_LOCK_KEY, instanceId, "NX", "PX", SWEEP_LOCK_TTL_MS);
    return result === "OK";
  }
}

/**
 * Server-side liveness sweep (CR-B of PR #251). Every tick, one web
 * instance (decided by `lock`) walks the `activity-leases` index for busy
 * displays whose lease has lapsed, asks the daemon directly via
 * `AgentActivityProbe`, and — once a probe times out without a reply —
 * synthesises `online` and pushes the corrected display so already-connected
 * browsers flip without waiting for their own next refresh.
 *
 * Construction never starts the loop; call `start()` explicitly. This keeps
 * the sweep inert at module import and in unit tests unless a test opts in.
 */
export class AgentActivitySweep {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;

  constructor(
    private readonly display: Pick<AgentDisplay, "staleLeases" | "sweepStale">,
    private readonly api: Pick<CentrifugoServerApi, "publish" | "publishJson">,
    private readonly lock: AgentActivitySweepLock,
    private readonly clock: () => number = Date.now,
    private readonly instanceId: string = crypto.randomUUID(),
    /** The Agent's current visibility, read fresh (no cache) for every synthesized
     * display push — never optional in effect: a lookup that finds nothing to route by skips
     * the publish entirely (fails closed) rather than defaulting to the shared channel. A
     * recognized non-`"public"` value routes it to the per-Agent one instead, same as the
     * publish proxy. */
    private readonly visibility: (scope: Scope) => Promise<string | undefined>,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), ACTIVITY_SWEEP_INTERVAL_MS);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Never rejects: this runs off a `setInterval` with no caller to observe a
   * rejection, so every failure is caught and logged instead. Skips outright
   * if a previous call is still in flight (a slow tick should not overlap
   * the next one in this same process; the Redis lock separately keeps two
   * different processes from ticking at once).
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (!(await this.lock.acquire(this.instanceId))) return;
      const now = this.clock();
      const stale = await this.display.staleLeases(now, SWEEP_BATCH_LIMIT);
      const results = await Promise.allSettled(stale.map((scope) => this.sweepOne(scope)));
      results.forEach((result, index) => {
        if (result.status !== "rejected") return;
        const scope = stale[index]!;
        console.error(
          JSON.stringify({
            event: "agent_activity_sweep.scope_failed",
            workspace_id: scope.workspaceId,
            computer_id: scope.computerId,
            agent_id: scope.agentId,
            error_type: result.reason instanceof Error ? result.reason.name : typeof result.reason,
          }),
        );
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "agent_activity_sweep.tick_failed",
          error_type: error instanceof Error ? error.name : typeof error,
        }),
      );
    } finally {
      this.ticking = false;
    }
  }

  private async sweepOne(scope: Scope): Promise<void> {
    const probeId = crypto.randomUUID();
    const result = await this.display.sweepStale(scope, {
      probeId,
      timeoutMs: ACTIVITY_PROBE_TIMEOUT_MS,
    });
    if (result.outcome === "probe") {
      await this.api.publish(
        daemonControlChannel(scope.workspaceId, scope.computerId),
        encodeAgentActivityProbe({
          protocolMajor: 1,
          requestId: crypto.randomUUID(),
          workspaceId: scope.workspaceId,
          computerId: scope.computerId,
          agentId: scope.agentId,
          probeId,
        }),
      );
      return;
    }
    if (result.outcome === "expired") {
      // Fail closed. A lookup that finds nothing to route by skips the publish
      // entirely rather than guessing the shared channel — the stale badge self-corrects on a
      // later tick once the lookup can answer.
      const visibility = await this.visibility(scope);
      if (visibility === undefined) return;
      const isPrivate = visibility !== AGENT_VISIBILITY.PUBLIC;
      const channel = isPrivate
        ? agentStatusChannelForAgent(scope.workspaceId, scope.agentId)
        : agentStatusChannel(scope.workspaceId);
      await this.api.publishJson(channel, {
        type: "agent:display",
        ...result.snapshot,
      });
    }
  }
}

let singleton: AgentActivitySweep | undefined;

function getAgentActivitySweep(): AgentActivitySweep {
  const redisUrl = redisUrlFor("the Agent activity sweep");
  singleton ??= new AgentActivitySweep(
    getAgentDisplay(),
    createCentrifugoServerApi(),
    new RedisAgentActivitySweepLock(new RedisClient(redisUrl)),
    undefined,
    undefined,
    async (scope) => {
      const db = getDatabaseClient();
      if (!db) return undefined;
      const agent = await db.agent.findUnique({
        where: { id: scope.agentId },
        select: { workspaceId: true, visibility: true },
      });
      return agent?.workspaceId === scope.workspaceId ? agent.visibility : undefined;
    },
  );
  return singleton;
}

/**
 * Idempotent per process. Only the real-traffic compositions call this — the
 * activity publication handler and the Centrifugo RPC composition — never a
 * unit test unless the test calls it explicitly.
 */
export function ensureAgentActivitySweep(): AgentActivitySweep {
  const sweep = getAgentActivitySweep();
  sweep.start();
  return sweep;
}
