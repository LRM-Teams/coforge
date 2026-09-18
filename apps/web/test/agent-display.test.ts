import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { RedisClient } from "bun";
import type { AgentActivity, AgentStatus } from "@lrm/coforge-sdk/internal";
import {
  RedisAgentDisplay,
  activityKindForObservation,
} from "../src/server/agents/agent-display.server";

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
const contextUsage = (
  sequence: number,
  overrides = {},
): import("@lrm/coforge-sdk/internal").AgentContextUsage => ({
  protocolMajor: 1,
  requestId: `context-usage-${sequence}`,
  ...scope,
  provider: "claude-code",
  launchId: "launch-a",
  sessionId: "native-session",
  usedTokens: 27_908,
  windowTokens: 200_000,
  observedAtMs: sequence * 100,
  daemonInstanceId: "daemon-a",
  clientSeq: sequence,
  ...overrides,
});

describe.skipIf(!redisServer)("RedisAgentDisplay", () => {
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

  test("reduces info to thinking to idle while the process remains online", async () => {
    await redis.send("FLUSHDB", []);
    const subject = display();
    expect((await subject.observeStatus(status(1)))?.activityKind).toBe("online");
    expect(
      (await subject.observeActivity(activity(1, "model_request_started"), fence))?.activityKind,
    ).toBe("working");
    expect(
      (await subject.observeActivity(activity(2, "thinking_started"), fence))?.activityKind,
    ).toBe("thinking");
    expect((await subject.observeActivity(activity(3, "idle"), fence))?.activityKind).toBe(
      "online",
    );
  });

  test("keeps errors online until recognized recovery and ignores unknown activity", async () => {
    await redis.send("FLUSHDB", []);
    const subject = display();
    await subject.observeStatus(status(1));
    expect(
      (await subject.observeActivity(activity(1, "runtime_error", { level: "error" }), fence))
        ?.activityKind,
    ).toBe("error");
    expect(await subject.observeActivity(activity(2, "future_kind"), fence)).toBeUndefined();
    expect((await subject.snapshot(scope)).activityKind).toBe("error");
    expect((await subject.observeActivity(activity(3, "tool_started"), fence))?.activityKind).toBe(
      "working",
    );
  });

  test("expires work at 90 seconds independently of the 90 second process lease", async () => {
    await redis.send("FLUSHDB", []);
    const subject = display();
    await subject.observeStatus(status(1));
    const working = await subject.observeActivity(activity(1, "running_command"), fence);
    expect(working?.expiresAt).toBe(now + 90_000);
    now += 60_000;
    // Renew the process lease on its own schedule; the work lease keeps counting
    // down from its own single observation, independently of that renewal.
    await subject.observeStatus(status(2));
    now += 30_000;
    const idle = await subject.snapshot(scope);
    expect(idle.activityKind).toBe("online");
    expect(idle.revision).toBeGreaterThan(working!.revision);
    now += 90_000;
    const offline = await subject.snapshot(scope);
    expect(offline.activityKind).toBe("offline");
    expect(offline.expiresAt).toBeNull();
    expect(offline.revision).toBeGreaterThan(idle.revision);
  });

  test("a busy heartbeat renews the work lease without bumping the revision", async () => {
    await redis.send("FLUSHDB", []);
    now = 3_000_000;
    const subject = display();
    await subject.observeStatus(status(1));
    await subject.observeActivity(activity(1, "tool_started"), fence);
    now += 30_000;
    // The daemon's own status heartbeat keeps the process lease ahead of the work
    // lease so the extended work expiry below isn't clamped by an older process lease.
    // It bumps the revision on its own; the busy heartbeat below must not bump it again.
    const renewed = await subject.observeStatus(status(2));
    const heartbeat = await subject.observeActivity(
      activity(2, "tool_started", { isHeartbeat: true, entries: [] }),
      fence,
    );
    expect(heartbeat?.activityKind).toBe("working");
    expect(heartbeat?.expiresAt).toBe(now + 90_000);
    expect(heartbeat?.revision).toBe(renewed!.revision);
  });

  test("a busy heartbeat after the lease lapsed still restores working", async () => {
    await redis.send("FLUSHDB", []);
    now = 3_200_000;
    const subject = display();
    await subject.observeStatus(status(1));
    await subject.observeActivity(activity(1, "tool_started"), fence);
    now += 90_000;
    // Keep the process alive independently of the lapsed work lease.
    await subject.observeStatus(status(2));
    const lapsed = await subject.snapshot(scope);
    expect(lapsed.activityKind).toBe("online");
    const heartbeat = await subject.observeActivity(
      activity(2, "tool_started", { isHeartbeat: true, entries: [] }),
      fence,
    );
    expect(heartbeat?.activityKind).toBe("working");
    expect(heartbeat?.expiresAt).toBe(now + 90_000);
    expect(heartbeat!.revision).toBeGreaterThan(lapsed.revision);
  });

  test.each(["tool_end", "thinking_end", "compaction_finished"])(
    "%s renews the lease and reads as working, like other busy detail kinds",
    async (detailKind) => {
      await redis.send("FLUSHDB", []);
      now = 3_100_000;
      const subject = display();
      await subject.observeStatus(status(1));
      const filler = await subject.observeActivity(activity(1, detailKind), fence);
      expect(filler?.activityKind).toBe("working");
      expect(filler?.expiresAt).toBe(now + 90_000);
    },
  );

  test.each(["tool_end", "thinking_end", "compaction_finished"])(
    "a repeated %s renews the lease without bumping the revision",
    async (detailKind) => {
      await redis.send("FLUSHDB", []);
      now = 3_150_000;
      const subject = display();
      await subject.observeStatus(status(1));
      const first = await subject.observeActivity(activity(1, detailKind), fence);
      now += 30_000;
      const renewed = await subject.observeStatus(status(2));
      const repeat = await subject.observeActivity(activity(2, detailKind), fence);
      expect(repeat?.revision).toBe(renewed!.revision);
      expect(repeat?.expiresAt).toBe(now + 90_000);
      expect(first).toBeDefined();
    },
  );

  test("runtime_progress renews the lease and reads as working, like other busy detail kinds", async () => {
    await redis.send("FLUSHDB", []);
    now = 3_400_000;
    const subject = display();
    await subject.observeStatus(status(1));
    const progress = await subject.observeActivity(activity(1, "runtime_progress"), fence);
    expect(progress?.activityKind).toBe("working");
    expect(progress?.expiresAt).toBe(now + 90_000);
  });

  test("does not revive expired work when the same activity is replayed", async () => {
    await redis.send("FLUSHDB", []);
    now = 1_500_000;
    const subject = display();
    await subject.observeStatus(status(1));
    await subject.observeActivity(activity(1, "running_command"), fence);
    now += 60_000;
    await subject.observeStatus(status(2)); // keep the process lease ahead of the work lease
    now += 30_000;
    expect((await subject.snapshot(scope)).activityKind).toBe("online");
    expect(await subject.observeActivity(activity(1, "running_command"), fence)).toBeUndefined();
    expect((await subject.snapshot(scope)).activityKind).toBe("online");
  });

  test("allows an identical active status fact to renew an expired process lease", async () => {
    await redis.send("FLUSHDB", []);
    now = 1_700_000;
    const subject = display();
    const active = status(1);
    await subject.observeStatus(active);
    now += 90_000;
    expect((await subject.snapshot(scope)).activityKind).toBe("offline");
    const renewed = await subject.observeStatus(active);
    expect(renewed?.activityKind).toBe("online");
    expect(renewed?.expiresAt).toBe(now + 90_000);
    expect(
      await subject.observeStatus(status(1, "inactive", { observedAtMs: active.observedAtMs })),
    ).toBeUndefined();
  });

  test("returns entries as an empty JSON array", async () => {
    await redis.send("FLUSHDB", []);
    now = 1_900_000;
    const snapshot = await display().snapshot(scope);
    expect(snapshot.entries).toEqual([]);
  });

  test("stale activity does not extend work and an active refresh preserves it", async () => {
    await redis.send("FLUSHDB", []);
    now = 2_000_000;
    const subject = display();
    await subject.observeStatus(status(1));
    const working = await subject.observeActivity(activity(2, "running_command"), fence);
    now += 10_000;
    expect(await subject.observeActivity(activity(2, "running_command"), fence)).toBeUndefined();
    expect((await subject.observeStatus(status(2)))?.activityKind).toBe("working");
    expect((await subject.snapshot(scope)).expiresAt).toBe(working!.expiresAt);
  });

  test("an active heartbeat cannot resurrect expired work", async () => {
    await redis.send("FLUSHDB", []);
    now = 2_500_000;
    const subject = display();
    await subject.observeStatus(status(1));
    await subject.observeActivity(activity(1, "running_command"), fence);
    now += 60_000;
    await subject.observeStatus(status(2)); // renew the process lease ahead of the work lease
    now += 30_000;
    expect((await subject.snapshot(scope)).activityKind).toBe("online");
    expect((await subject.observeStatus(status(3)))?.activityKind).toBe("online");
  });

  test("keeps revisions above browser high-water after Redis state and counter loss", async () => {
    await redis.send("FLUSHDB", []);
    now = 2_700_000;
    const subject = display();
    const beforeReset = await subject.observeStatus(status(1));
    expect(beforeReset).toBeDefined();

    await redis.send("FLUSHDB", []);
    const afterReset = await subject.snapshot(scope);

    expect(Number.isSafeInteger(afterReset.revision)).toBeTrue();
    expect(afterReset.revision).toBeGreaterThan(beforeReset!.revision);
  });

  test("keeps the revision counter persistent and monotonic if only it is evicted", async () => {
    await redis.send("FLUSHDB", []);
    now = 2_800_000;
    const subject = display();
    const first = await subject.observeStatus(status(1));
    expect(first).toBeDefined();
    const prefix = "coforge:workspace:workspace-a:computer:computer-a:agent:agent-a:display:v1";
    expect(await redis.send("TTL", [`${prefix}:revision`])).toBe(-1);

    await redis.send("DEL", [`${prefix}:revision`]);
    const second = await subject.observeStatus(status(2));
    expect(second?.revision).toBeGreaterThan(first!.revision);
    expect(await redis.send("TTL", [`${prefix}:revision`])).toBe(-1);
  });

  test("returns every exact revision when the persistent counter exceeds cjson precision", async () => {
    await redis.send("FLUSHDB", []);
    now = 2_900_000;
    const prefix = "coforge:workspace:workspace-a:computer:computer-a:agent:agent-a:display:v1";
    // Above current Redis wall time and cjson precision, within JS safe integers.
    await redis.send("SET", [`${prefix}:revision`, "8000000000000000"]);
    const subject = display();

    const first = await subject.observeStatus(status(1));
    const second = await subject.observeActivity(activity(1, "running_command"), fence);

    expect(first?.revision).toBe(8_000_000_000_000_001);
    expect(second?.revision).toBe(8_000_000_000_000_002);
    expect(await redis.get(`${prefix}:revision`)).toBe("8000000000000002");
    expect(JSON.parse((await redis.get(`${prefix}:state`))!).revision).toBe("8000000000000002");
  });

  test("inactive dominates and rejects retired launch and daemon replays", async () => {
    await redis.send("FLUSHDB", []);
    now = 3_000_000;
    const subject = display();
    await subject.observeStatus(status(1));
    await subject.observeActivity(activity(1, "running_command"), fence);
    expect((await subject.observeStatus(status(2, "inactive")))?.activityKind).toBe("offline");
    expect(await subject.observeActivity(activity(2, "running_command"), fence)).toBeUndefined();
    await subject.observeStatus(
      status(1, "active", { daemonInstanceId: "daemon-b", observedAtMs: 1_000 }),
    );
    expect((await subject.snapshot(scope)).activityKind).toBe("online");
    expect(await subject.observeActivity(activity(1, "running_command"), fence)).toBeUndefined();
    const fenceB = { daemonInstanceId: "daemon-b", launchId: "launch-b" };
    await subject.observeActivity(
      activity(1, "running_command", { launchId: "launch-b", observedAtMs: 2_000 }),
      fenceB,
    );
    expect(
      await subject.observeActivity(activity(99, "running_command", { observedAtMs: 1_500 }), {
        ...fenceB,
        launchId: "launch-a",
      }),
    ).toBeUndefined();
  });

  test("isolates scopes and atomically preserves interleaved process and activity updates", async () => {
    await redis.send("FLUSHDB", []);
    now = 4_000_000;
    const subject = display();
    const other = { ...scope, workspaceId: "workspace-b" };
    await Promise.all([
      subject.observeActivity(activity(1, "thinking_started"), fence),
      subject.observeStatus(status(1)),
      subject.observeStatus(status(1, "active", other)),
    ]);
    expect((await subject.snapshot(scope)).activityKind).toBe("thinking");
    expect((await subject.snapshot(other)).activityKind).toBe("online");
  });

  test("preserves a same-daemon observation received before the first active status", async () => {
    await redis.send("FLUSHDB", []);
    now = 5_000_000;
    const subject = display();
    expect(
      (await subject.observeActivity(activity(1, "thinking_started"), fence))?.activityKind,
    ).toBe("offline");
    expect((await subject.observeStatus(status(1)))?.activityKind).toBe("thinking");
  });

  test("preserves provisional same-daemon activity when snapshot initialized the scope", async () => {
    await redis.send("FLUSHDB", []);
    now = 5_500_000;
    const subject = display();
    await subject.snapshot(scope);
    await subject.observeActivity(activity(1, "thinking_started"), fence);
    expect((await subject.observeStatus(status(1)))?.activityKind).toBe("thinking");
  });

  test("puts a context-window reading and surfaces it only while the process is active", async () => {
    await redis.send("FLUSHDB", []);
    now = 6_000_000;
    const subject = display();
    // No process yet: the reading is stored but never surfaced while offline.
    expect((await subject.putContextUsage(contextUsage(1)))?.contextUsage).toBeNull();
    await subject.observeStatus(status(1));
    const put = await subject.putContextUsage(contextUsage(2));
    expect(put?.contextUsage).toEqual({
      usedTokens: 27_908,
      windowTokens: 200_000,
      observedAtMs: 200,
    });
    expect((await subject.snapshot(scope)).contextUsage).toEqual(put!.contextUsage);
  });

  test("bumps the revision only when the reading actually changes", async () => {
    await redis.send("FLUSHDB", []);
    now = 6_100_000;
    const subject = display();
    await subject.observeStatus(status(1));
    const first = await subject.putContextUsage(contextUsage(2));
    const repeat = await subject.putContextUsage(contextUsage(3));
    expect(repeat?.revision).toBe(first!.revision);
    const changed = await subject.putContextUsage(contextUsage(4, { usedTokens: 40_000 }));
    expect(changed!.revision).toBeGreaterThan(repeat!.revision);
    expect(changed?.contextUsage).toEqual({
      usedTokens: 40_000,
      windowTokens: 200_000,
      observedAtMs: 400,
    });
  });

  test("rejects a stale same-instance clientSeq but accepts an advancing one", async () => {
    await redis.send("FLUSHDB", []);
    now = 6_200_000;
    const subject = display();
    await subject.observeStatus(status(1));
    await subject.putContextUsage(contextUsage(5));
    // Same daemon instance, non-advancing clientSeq: rejected.
    expect(await subject.putContextUsage(contextUsage(5, { usedTokens: 1 }))).toBeUndefined();
    expect((await subject.snapshot(scope)).contextUsage).toMatchObject({ usedTokens: 27_908 });
    const advanced = await subject.putContextUsage(contextUsage(6, { usedTokens: 30_000 }));
    expect(advanced?.contextUsage).toMatchObject({ usedTokens: 30_000 });
  });

  test("clears the reading once the process goes inactive, and a failover daemon instance starts fresh", async () => {
    await redis.send("FLUSHDB", []);
    now = 6_300_000;
    const subject = display();
    await subject.observeStatus(status(1));
    await subject.putContextUsage(contextUsage(1));
    expect((await subject.observeStatus(status(2, "inactive")))?.contextUsage).toBeNull();
    // A different daemon instance taking the process over also clears the old reading — it
    // belongs to the daemon instance that failed, not the one now reporting the process active.
    await subject.observeStatus(status(3, "active", { daemonInstanceId: "daemon-b" }));
    expect((await subject.snapshot(scope)).contextUsage).toBeNull();
    // The new daemon instance's own reading is then accepted and shown, starting clean.
    const fromNewInstance = await subject.putContextUsage(
      contextUsage(1, { daemonInstanceId: "daemon-b", usedTokens: 5 }),
    );
    expect(fromNewInstance?.contextUsage).toMatchObject({ usedTokens: 5 });
  });

  test("clears a retired launch's reading once a newer launch's Activity replaces it", async () => {
    await redis.send("FLUSHDB", []);
    now = 6_400_000;
    const subject = display();
    await subject.observeStatus(status(1));
    // Seed a launch-a Activity so the launch-b Activity below has something to retire.
    await subject.observeActivity(activity(1, "starting"), fence);
    await subject.putContextUsage(contextUsage(1));
    expect((await subject.snapshot(scope)).contextUsage).not.toBeNull();
    const fenceB = { daemonInstanceId: "daemon-a", launchId: "launch-b" };
    await subject.observeActivity(
      activity(2, "starting", { launchId: "launch-b", observedAtMs: 100_001 }),
      fenceB,
    );
    expect((await subject.snapshot(scope)).contextUsage).toBeNull();
  });
});

test("activityKindForObservation is stateless and leaves unknown facts unclassified", () => {
  expect(activityKindForObservation({ detailKind: "thinking_started", level: "info" })).toBe(
    "thinking",
  );
  expect(activityKindForObservation({ detailKind: "running_command", level: "info" })).toBe(
    "working",
  );
  expect(activityKindForObservation({ detailKind: "runtime_reconnecting", level: "info" })).toBe(
    "working",
  );
  // Cold start after a session invalidate (ADR 0040) must be visible, not dropped.
  expect(activityKindForObservation({ detailKind: "runtime_unavailable", level: "info" })).toBe(
    "working",
  );
  expect(activityKindForObservation({ detailKind: "anything", level: "error" })).toBe("error");
  expect(activityKindForObservation({ detailKind: "idle", level: "info" })).toBe("online");
  expect(activityKindForObservation({ detailKind: "future", level: "info" })).toBeUndefined();
});

// ADR 0021
test("activityKindForObservation classifies the new detail kinds", () => {
  for (const detailKind of [
    "tool_end",
    "thinking_end",
    "compacting_context",
    "compaction_finished",
    "subagent_activity",
    "message_received",
  ])
    expect(activityKindForObservation({ detailKind, level: "info" })).toBe("working");
  expect(activityKindForObservation({ detailKind: "runtime_crashed", level: "error" })).toBe(
    "error",
  );
  expect(activityKindForObservation({ detailKind: "runtime_interrupted", level: "info" })).toBe(
    "online",
  );
});

// This change's additions to the shared vocabulary.
test("activityKindForObservation classifies this change's new detail kinds", () => {
  for (const detailKind of [
    "reviewing_changes",
    "review_finished",
    "compaction_stale",
    "review_stale",
    "stalled_recovery",
    "system_message",
  ])
    expect(activityKindForObservation({ detailKind, level: "info" })).toBe("working");
  expect(activityKindForObservation({ detailKind: "runtime_stalled", level: "error" })).toBe(
    "error",
  );
  // Also follows how runtime_error/runtime_crashed map: matched by detailKind
  // alone, independent of the level the frame actually carries.
  expect(activityKindForObservation({ detailKind: "runtime_stalled", level: "info" })).toBe(
    "error",
  );
});

test("working and runtime_starting are dropped: nothing in the daemon emits either", () => {
  expect(activityKindForObservation({ detailKind: "working", level: "info" })).toBeUndefined();
  expect(
    activityKindForObservation({ detailKind: "runtime_starting", level: "info" }),
  ).toBeUndefined();
  expect(
    activityKindForObservation({ detailKind: "turn_completed", level: "info" }),
  ).toBeUndefined();
});
