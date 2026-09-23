import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { RedisClient } from "bun";
import type { AgentActivity, AgentStatus } from "@lrm/coforge-sdk/internal";
import { decodeAgentActivityProbe } from "@lrm/coforge-sdk/internal";
import { RedisAgentDisplay } from "@/server/agents/agent-display.server";
import {
  ACTIVITY_PROBE_TIMEOUT_MS,
  AgentActivitySweep,
  RedisAgentActivitySweepLock,
  type AgentActivitySweepLock,
} from "@/server/agents/agent-activity-sweep.server";
import { daemonControlChannel } from "@/server/centrifugo/server-api.server";
import {
  agentStatusChannel,
  agentStatusChannelForAgent,
} from "@/features/agents/agent-status-realtime";

const redisServer = Bun.which("redis-server");
const port = 20_000 + Math.floor(Math.random() * 20_000);
const url = `redis://127.0.0.1:${port}`;
let process: ReturnType<typeof Bun.spawn> | undefined;
let redis: RedisClient;
let now = 1_000_000;

const scope = { workspaceId: "workspace-a", computerId: "computer-a", agentId: "agent-a" };
const status = (
  sequence: number,
  state: "active" | "inactive" = "active",
  overrides = {},
): AgentStatus => ({
  protocolMajor: 1,
  requestId: `status-${sequence}`,
  ...scope,
  status: state,
  daemonInstanceId: "daemon-a",
  clientSeq: sequence,
  observedAtMs: sequence * 100,
  ...overrides,
});
const activity = (
  sequence: number,
  detailKind: string,
  overrides = {},
): AgentActivity & { computerId: string } => ({
  protocolMajor: 1,
  requestId: `activity-${sequence}`,
  ...scope,
  detailKind,
  level: "info",
  detail: detailKind,
  observedAtMs: sequence * 100,
  launchId: "launch-a",
  clientSeq: sequence,
  ...overrides,
});
const fence = { daemonInstanceId: "daemon-a", launchId: "launch-a" };

/** Always succeeds: isolates sweep/business-logic tests from the lock's real-time TTL. */
const permissiveLock: AgentActivitySweepLock = { acquire: async () => true };

type Recorded = { channel: string; data: Uint8Array };
type RecordedJson = { channel: string; data: unknown };

function fakeApi() {
  const published: Recorded[] = [];
  const publishedJson: RecordedJson[] = [];
  return {
    api: {
      publish: async (channel: string, data: Uint8Array) => {
        published.push({ channel, data });
      },
      publishJson: async (channel: string, data: unknown) => {
        publishedJson.push({ channel, data });
      },
    },
    published,
    publishedJson,
  };
}

describe.skipIf(!redisServer)("AgentActivitySweep", () => {
  beforeAll(async () => {
    process = Bun.spawn(
      [redisServer!, "--port", String(port), "--save", "", "--appendonly", "no"],
      {
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    redis = new RedisClient(url);
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await redis.send("PING", []);
        return;
      } catch {
        await Bun.sleep(10);
      }
    }
    throw new Error("isolated redis-server did not become ready");
  });

  afterAll(async () => {
    redis?.close();
    process?.kill();
    await process?.exited;
  });

  const display = () => new RedisAgentDisplay(redis, () => now);

  // Renews the process lease ahead of the work lease, exactly like
  // agent-display.test.ts's "expires work at 90 seconds independently of the
  // 90 second process lease": leaves a stale busy activity behind while the
  // process itself stays online, which is the scenario SWEEP_STALE targets.
  async function staleBusyLease() {
    const subject = display();
    await subject.observeStatus(status(1));
    await subject.observeActivity(activity(1, "tool_started"), fence);
    now += 60_000;
    await subject.observeStatus(status(2));
    now += 30_000; // the 90s work lease is now exactly stale; the process lease is not
    return subject;
  }

  test("OBSERVE_ACTIVITY/OBSERVE_STATUS keep the lease index in sync", async () => {
    await redis.send("FLUSHDB", []);
    now = 1_000_000;
    const subject = display();
    await subject.observeStatus(status(1));
    await subject.observeActivity(activity(1, "tool_started"), fence);
    expect(await subject.staleLeases(now + 10_000_000, 10)).toEqual([scope]);

    await subject.observeActivity(activity(2, "idle"), fence);
    expect(await subject.staleLeases(now + 10_000_000, 10)).toEqual([]);

    await subject.observeActivity(activity(3, "tool_started"), fence);
    expect(await subject.staleLeases(now + 10_000_000, 10)).toEqual([scope]);
    await subject.observeStatus(status(2, "inactive", { observedAtMs: 10_000 }));
    expect(await subject.staleLeases(now + 10_000_000, 10)).toEqual([]);
  });

  test("a stale busy lease yields exactly one probe publish until the timeout", async () => {
    await redis.send("FLUSHDB", []);
    now = 2_000_000;
    const subject = await staleBusyLease();
    const { api, published } = fakeApi();
    const sweep = new AgentActivitySweep(
      subject,
      api,
      permissiveLock,
      () => now,
      undefined,
      async () => "public",
    );

    await sweep.tick();
    expect(published).toHaveLength(1);
    expect(published[0]!.channel).toBe(daemonControlChannel(scope.workspaceId, scope.computerId));
    const probe = decodeAgentActivityProbe(published[0]!.data);
    expect(probe).toMatchObject({ workspaceId: scope.workspaceId, agentId: scope.agentId });

    now += 1_000; // still under ACTIVITY_PROBE_TIMEOUT_MS
    await sweep.tick();
    now += 1_000;
    await sweep.tick();
    expect(published).toHaveLength(1);
  });

  test("after the probe timeout the sweep publishes online and removes the member", async () => {
    await redis.send("FLUSHDB", []);
    now = 2_500_000;
    const subject = await staleBusyLease();
    const { api, published, publishedJson } = fakeApi();
    const sweep = new AgentActivitySweep(
      subject,
      api,
      permissiveLock,
      () => now,
      undefined,
      async () => "public",
    );

    await sweep.tick();
    expect(published).toHaveLength(1);

    now += ACTIVITY_PROBE_TIMEOUT_MS;
    await sweep.tick();

    expect(published).toHaveLength(1); // the timeout does not send a second probe
    expect(publishedJson).toHaveLength(1);
    expect(publishedJson[0]!.channel).toBe(agentStatusChannel(scope.workspaceId));
    expect(publishedJson[0]!.data).toMatchObject({ type: "agent:display", activityKind: "online" });
    expect(await subject.staleLeases(now + 10_000_000, 10)).toEqual([]);
  });

  test("a probe reply observed before the timeout clears the pending probe and re-indexes", async () => {
    await redis.send("FLUSHDB", []);
    now = 3_000_000;
    const subject = await staleBusyLease();
    const { api, published, publishedJson } = fakeApi();
    const sweep = new AgentActivitySweep(
      subject,
      api,
      permissiveLock,
      () => now,
      undefined,
      async () => "public",
    );

    await sweep.tick();
    const probe = decodeAgentActivityProbe(published[0]!.data);

    now += 2_000; // still under the timeout
    const reply = await subject.observeActivity(
      activity(2, "tool_started", { probeId: probe.probeId, entries: [] }),
      fence,
    );
    expect(reply?.activityKind).toBe("working");
    // The lease is re-indexed into the future, so it is no longer stale.
    expect(await subject.staleLeases(now, 10)).toEqual([]);

    now += ACTIVITY_PROBE_TIMEOUT_MS; // past the original probe's timeout
    await sweep.tick();
    expect(published).toHaveLength(1); // no repeat probe
    expect(publishedJson).toHaveLength(0); // and no synthesized online: the reply kept it alive
  });

  test("the Redis lock keeps a second sweeper from ticking in the same window", async () => {
    await redis.send("FLUSHDB", []);
    now = 4_000_000;
    const subject = await staleBusyLease();
    const first = fakeApi();
    const second = fakeApi();
    const sweepA = new AgentActivitySweep(
      subject,
      first.api,
      new RedisAgentActivitySweepLock(redis),
      () => now,
      "instance-a",
      async () => "public",
    );
    const sweepB = new AgentActivitySweep(
      subject,
      second.api,
      new RedisAgentActivitySweepLock(redis),
      () => now,
      "instance-b",
      async () => "public",
    );

    await sweepA.tick();
    await sweepB.tick();

    expect(first.published).toHaveLength(1);
    expect(second.published).toHaveLength(0);
  });

  test("SWEEP_STALE re-indexes a lease renewed between staleLeases and the call, instead of dropping it", async () => {
    await redis.send("FLUSHDB", []);
    now = 5_000_000;
    const subject = await staleBusyLease();
    const staleNow = now;
    expect(await subject.staleLeases(staleNow, 10)).toEqual([scope]);

    // Simulate the race: a heartbeat or real observation renews the lease
    // after ZRANGEBYSCORE found this member stale but before SWEEP_STALE runs.
    const renewed = await subject.observeActivity(activity(2, "tool_started"), fence);
    expect(renewed?.activityKind).toBe("working");
    expect(renewed!.expiresAt!).toBeGreaterThan(staleNow);

    const result = await subject.sweepStale(scope, {
      probeId: "probe-race",
      timeoutMs: ACTIVITY_PROBE_TIMEOUT_MS,
    });
    expect(result.outcome).toBe("fresh");

    // Re-indexed at its renewed score, not dropped: still absent at the old
    // stale cutoff, but present again once its (possibly process-lease-
    // clamped) renewed deadline is reached. `renewed.expiresAt` is the
    // display-facing value, which can be clamped to the process lease, so
    // this checks comfortably past it rather than at its exact value.
    expect(await subject.staleLeases(staleNow, 10)).toEqual([]);
    expect(await subject.staleLeases(renewed!.expiresAt! + 200_000, 10)).toEqual([scope]);
  });
});

function expiredSnapshot(scope: { workspaceId: string; computerId: string; agentId: string }) {
  return {
    protocolMajor: 1 as const,
    ...scope,
    revision: 1,
    activityKind: "online" as const,
    detailKind: "idle",
    detail: "",
    entries: [],
    expiresAt: null,
  };
}

test("sweepOne publishes a private Agent's synthesized display to its per-Agent status channel", async () => {
  const privateScope = { workspaceId: "workspace-p", computerId: "computer-p", agentId: "agent-p" };
  const snapshot = expiredSnapshot(privateScope);
  const display = {
    staleLeases: async () => [privateScope],
    sweepStale: async () => ({ outcome: "expired" as const, snapshot }),
  };
  const { api, publishedJson } = fakeApi();
  const sweep = new AgentActivitySweep(
    display,
    api,
    permissiveLock,
    () => now,
    undefined,
    async (scope) => (scope.agentId === privateScope.agentId ? "private" : "public"),
  );

  await sweep.tick();

  expect(publishedJson).toHaveLength(1);
  expect(publishedJson[0]!.channel).toBe(
    agentStatusChannelForAgent(privateScope.workspaceId, privateScope.agentId),
  );
  expect(publishedJson[0]!.data).toMatchObject({ type: "agent:display", ...snapshot });
});

test("sweepOne keeps publishing a public Agent's synthesized display to the shared status channel", async () => {
  const publicScope = { workspaceId: "workspace-q", computerId: "computer-q", agentId: "agent-q" };
  const snapshot = expiredSnapshot(publicScope);
  const display = {
    staleLeases: async () => [publicScope],
    sweepStale: async () => ({ outcome: "expired" as const, snapshot }),
  };
  const { api, publishedJson } = fakeApi();
  const sweep = new AgentActivitySweep(
    display,
    api,
    permissiveLock,
    () => now,
    undefined,
    async () => "public",
  );

  await sweep.tick();

  expect(publishedJson).toHaveLength(1);
  expect(publishedJson[0]!.channel).toBe(agentStatusChannel(publicScope.workspaceId));
});

// `visibility` is a required dependency (no `?`): a lookup that cannot answer the visibility
// question must not silently fall back to publishing on the shared channel.
test("sweepOne skips the publish when the visibility lookup finds nothing to route by (fail closed)", async () => {
  const scopeWithoutVisibility = {
    workspaceId: "workspace-r",
    computerId: "computer-r",
    agentId: "agent-r",
  };
  const snapshot = expiredSnapshot(scopeWithoutVisibility);
  const display = {
    staleLeases: async () => [scopeWithoutVisibility],
    sweepStale: async () => ({ outcome: "expired" as const, snapshot }),
  };
  const { api, publishedJson } = fakeApi();
  const sweep = new AgentActivitySweep(
    display,
    api,
    permissiveLock,
    () => now,
    undefined,
    async () => undefined,
  );

  await sweep.tick();

  expect(publishedJson).toHaveLength(0);
});

test("tick() resolves and completes the other scopes when one scope's sweepStale throws", async () => {
  const okScope = { workspaceId: "workspace-ok", computerId: "computer-ok", agentId: "agent-ok" };
  const badScope = {
    workspaceId: "workspace-bad",
    computerId: "computer-bad",
    agentId: "agent-bad",
  };
  const display = {
    staleLeases: async () => [badScope, okScope],
    sweepStale: async (scope: { workspaceId: string }) => {
      if (scope.workspaceId === badScope.workspaceId) throw new Error("Redis unavailable");
      return { outcome: "probe" as const };
    },
  };
  const { api, published } = fakeApi();
  const errorSpy = spyOn(console, "error").mockImplementation(() => {});
  try {
    const sweep = new AgentActivitySweep(
      display,
      api,
      permissiveLock,
      () => now,
      undefined,
      async () => "public",
    );
    await expect(sweep.tick()).resolves.toBeUndefined();
    expect(published).toHaveLength(1);
    expect(decodeAgentActivityProbe(published[0]!.data)).toMatchObject({
      workspaceId: okScope.workspaceId,
    });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(errorSpy.mock.calls[0]![0] as string) as Record<string, unknown>;
    expect(logged).toMatchObject({
      event: "agent_activity_sweep.scope_failed",
      workspace_id: badScope.workspaceId,
      error_type: "Error",
    });
  } finally {
    errorSpy.mockRestore();
  }
});

test("tick() never rejects even when staleLeases itself throws", async () => {
  const display = {
    staleLeases: async () => {
      throw new Error("Redis unavailable");
    },
    sweepStale: async () => ({ outcome: "fresh" as const }),
  };
  const { api } = fakeApi();
  const errorSpy = spyOn(console, "error").mockImplementation(() => {});
  try {
    const sweep = new AgentActivitySweep(
      display,
      api,
      permissiveLock,
      () => now,
      undefined,
      async () => "public",
    );
    await expect(sweep.tick()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(errorSpy.mock.calls[0]![0] as string) as Record<string, unknown>;
    expect(logged).toMatchObject({
      event: "agent_activity_sweep.tick_failed",
      error_type: "Error",
    });
  } finally {
    errorSpy.mockRestore();
  }
});

test("tick() skips a concurrent call while a previous tick is still in flight", async () => {
  let releaseFirst!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let staleLeasesCalls = 0;
  const display = {
    staleLeases: async () => {
      staleLeasesCalls += 1;
      await gate;
      return [];
    },
    sweepStale: async () => ({ outcome: "fresh" as const }),
  };
  const { api } = fakeApi();
  const sweep = new AgentActivitySweep(
    display,
    api,
    permissiveLock,
    () => now,
    undefined,
    async () => "public",
  );
  const first = sweep.tick();
  const second = sweep.tick(); // should skip immediately, not wait on the gate
  await second;
  expect(staleLeasesCalls).toBe(1);
  releaseFirst();
  await first;
});

test("stop() clears the interval timer without waiting for it to fire, and start()/stop() are idempotent", () => {
  const noopDisplay = {
    staleLeases: async () => [],
    sweepStale: async () => ({ outcome: "fresh" as const }),
  };
  const noopApi = { publish: async () => {}, publishJson: async () => {} };
  const sweep = new AgentActivitySweep(
    noopDisplay,
    noopApi,
    permissiveLock,
    () => now,
    undefined,
    async () => "public",
  );
  const setSpy = spyOn(globalThis, "setInterval");
  const clearSpy = spyOn(globalThis, "clearInterval");
  try {
    sweep.start();
    sweep.start(); // idempotent: does not start a second interval
    expect(setSpy).toHaveBeenCalledTimes(1);
    const handle = setSpy.mock.results[0]!.value;
    sweep.stop();
    expect(clearSpy).toHaveBeenCalledWith(handle);
    sweep.stop(); // idempotent: nothing left to clear
    expect(clearSpy).toHaveBeenCalledTimes(1);
  } finally {
    setSpy.mockRestore();
    clearSpy.mockRestore();
  }
});
