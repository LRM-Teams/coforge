import { expect, test } from "bun:test";
import type {
  ReminderFireRequest,
  ReminderFireResponse,
  ReminderJob,
  ReminderSync,
} from "@coforge/protocol";
import {
  ReminderScheduler,
  type ReminderClock,
  type ReminderReceipt,
  type ReminderReceiptStore,
} from "../src/agent-reminder/reminder-scheduler";

class MemoryStore implements ReminderReceiptStore {
  receipts: ReminderReceipt[] = [];
  async read() {
    return structuredClone(this.receipts);
  }
  async write(_agentId: string, receipts: readonly ReminderReceipt[]) {
    this.receipts = structuredClone([...receipts]);
  }
}

class Clock implements ReminderClock {
  time = Date.parse("2026-09-08T12:00:00Z");
  timers: Array<{ at: number; callback: () => void }> = [];
  now = () => this.time;
  schedule(callback: () => void, delayMs: number) {
    const timer = { at: this.time + delayMs, callback };
    this.timers.push(timer);
    return timer;
  }
  cancel(timer: unknown) {
    this.timers = this.timers.filter((item) => item !== timer);
  }
  async advance(ms: number) {
    this.time += ms;
    const due = this.timers.filter((timer) => timer.at <= this.time);
    this.timers = this.timers.filter((timer) => timer.at > this.time);
    for (const timer of due) timer.callback();
    await Promise.all(due.map(async () => {}));
  }
}

const job: ReminderJob = {
  reminderId: "123e4567-e89b-42d3-a456-426614174000",
  ownerAgentId: "agent-a",
  version: 3,
  title: "Review",
  target: "@frank",
  messageId: "123e4567-e89b-42d3-a456-426614174001",
  fireAt: "2026-09-08T12:00:01Z",
};
const snapshot = (jobs: ReminderJob[]): ReminderSync => ({
  protocolMajor: 1,
  requestId: crypto.randomUUID(),
  workspaceId: "workspace-a",
  computerId: "computer-a",
  agentId: "agent-a",
  operation: "snapshot",
  jobs,
  messageType: "coforge.rpc.v1.ReminderSync",
});
const change = (operation: "upsert" | "cancel", version: number): ReminderSync => ({
  ...snapshot([]),
  operation,
  jobs: operation === "upsert" ? [{ ...job, version }] : [],
  reminderId: operation === "cancel" ? job.reminderId : undefined,
  version: operation === "cancel" ? version : undefined,
});

test("fires only an authoritative snapshot job and persists identity before waking", async () => {
  const store = new MemoryStore();
  const clock = new Clock();
  const observed: string[] = [];
  const scheduler = new ReminderScheduler(
    { workspaceId: "workspace-a", computerId: "computer-a" },
    store,
    async (request) => {
      expect(store.receipts[0]?.requestId).toBe(request.requestId);
      observed.push("fire");
      return {
        ...request,
        result: "accepted",
        fired: true,
        catchup: false,
      } satisfies ReminderFireResponse;
    },
    async () => {
      observed.push("wake");
      return true;
    },
    clock,
  );
  await scheduler.apply(snapshot([job]));
  await clock.advance(1000);
  await scheduler.awaitIdle();
  expect(observed).toEqual(["fire", "wake"]);
  expect(store.receipts[0]).toMatchObject({
    attempt: 2,
    serverResult: "accepted",
    wakeAccepted: true,
  });
});

test("replacement snapshot cancels the old timer and exact revision ack is idempotent", async () => {
  const store = new MemoryStore();
  const clock = new Clock();
  let fires = 0;
  const scheduler = new ReminderScheduler(
    { workspaceId: "workspace-a", computerId: "computer-a" },
    store,
    async (request) => {
      fires++;
      return { ...request, result: "accepted", fired: true, catchup: false };
    },
    async () => true,
    clock,
  );
  await scheduler.apply(snapshot([job]));
  await scheduler.apply(snapshot([]));
  await clock.advance(2000);
  expect(fires).toBe(0);
  store.receipts = [
    {
      workspaceId: "workspace-a",
      computerId: "computer-a",
      agentId: "agent-a",
      reminderId: job.reminderId,
      version: 3,
      job,
      requestId: "stable",
      firedAtClient: job.fireAt,
      attempt: 1,
      deadline: clock.time + 1,
      nextAt: clock.time,
      serverResult: "accepted",
      serverFired: true,
      serverCatchup: false,
      wakeAccepted: true,
      consumed: false,
      terminal: false,
    },
  ];
  expect(await scheduler.acknowledge("agent-a", job.reminderId, 2)).toBe(false);
  expect(await scheduler.acknowledge("agent-a", job.reminderId, 3)).toBe(true);
  expect(await scheduler.acknowledge("agent-a", job.reminderId, 3)).toBe(true);
});

test("an empty authoritative snapshot restores a committed occurrence payload", async () => {
  const clock = new Clock();
  const store = new MemoryStore();
  store.receipts = [
    {
      workspaceId: "workspace-a",
      computerId: "computer-a",
      agentId: "agent-a",
      reminderId: job.reminderId,
      version: job.version,
      job,
      requestId: "stable",
      firedAtClient: job.fireAt,
      attempt: 1,
      deadline: clock.time + 60_000,
      nextAt: clock.time,
      wakeAccepted: false,
      consumed: false,
      terminal: false,
    },
  ];
  const requests: string[] = [];
  const scheduler = new ReminderScheduler(
    { workspaceId: "workspace-a", computerId: "computer-a" },
    store,
    async (request) => {
      requests.push(request.requestId);
      return { ...request, result: "accepted", fired: true, catchup: true };
    },
    async (restored) => restored.title === "Review",
    clock,
  );
  await scheduler.apply(snapshot([]));
  await clock.advance(0);
  await scheduler.awaitIdle();
  expect(requests).toEqual(["stable"]);
  expect(store.receipts[0]).toMatchObject({ serverFired: true, wakeAccepted: true });
});

test("cancel tombstone rejects the same and older upsert versions", async () => {
  const clock = new Clock();
  let fires = 0;
  const scheduler = new ReminderScheduler(
    { workspaceId: "workspace-a", computerId: "computer-a" },
    new MemoryStore(),
    async (request) => {
      fires++;
      return { ...request, result: "accepted", fired: true, catchup: false };
    },
    async () => true,
    clock,
  );
  await scheduler.apply(snapshot([job]));
  await scheduler.apply(change("cancel", 4));
  await scheduler.apply(change("upsert", 4));
  await scheduler.apply(change("upsert", 3));
  await clock.advance(2000);
  expect(fires).toBe(0);
});

test("stop during a pending fire prevents its response from waking or arming", async () => {
  const clock = new Clock();
  let resolve!: (response: ReminderFireResponse) => void;
  let fireStarted!: () => void;
  const started = new Promise<void>((done) => (fireStarted = done));
  let wakes = 0;
  const scheduler = new ReminderScheduler(
    { workspaceId: "workspace-a", computerId: "computer-a" },
    new MemoryStore(),
    (_request) =>
      new Promise((done) => {
        fireStarted();
        resolve = (response) => done(response);
      }),
    async () => {
      wakes++;
      return true;
    },
    clock,
  );
  await scheduler.apply(snapshot([job]));
  await clock.advance(1000);
  await started;
  scheduler.stop();
  resolve({
    protocolMajor: 1,
    requestId: "ignored",
    workspaceId: "workspace-a",
    computerId: "computer-a",
    agentId: "agent-a",
    reminderId: job.reminderId,
    version: job.version,
    result: "accepted",
    fired: true,
    catchup: false,
  });
  await scheduler.awaitIdle();
  expect(wakes).toBe(0);
  expect(clock.timers).toHaveLength(0);
});

test("a rejected network request completes and retries the same durable occurrence", async () => {
  const clock = new Clock();
  const store = new MemoryStore();
  const ids: string[] = [];
  const scheduler = new ReminderScheduler(
    { workspaceId: "workspace-a", computerId: "computer-a" },
    store,
    async (request) => {
      ids.push(request.requestId);
      if (ids.length === 1) throw new Error("offline");
      return { ...request, result: "accepted", fired: false, catchup: false };
    },
    async () => {
      throw new Error("must not wake");
    },
    clock,
  );
  await scheduler.apply(snapshot([job]));
  await clock.advance(1000);
  await scheduler.awaitIdle();
  await clock.advance(1000);
  await scheduler.awaitIdle();
  expect(ids).toHaveLength(2);
  expect(new Set(ids).size).toBe(1);
  expect(store.receipts[0]).toMatchObject({ attempt: 2, terminal: true, serverFired: false });
});

for (const [field, mismatch] of [
  ["requestId", "another-request"],
  ["workspaceId", "another-workspace"],
  ["computerId", "another-computer"],
  ["agentId", "another-agent"],
  ["reminderId", "123e4567-e89b-42d3-a456-426614174099"],
  ["protocolMajor", 2],
  ["version", 4],
] as const) {
  test(`a fire response with mismatched ${field} is not accepted or woken`, async () => {
    const clock = new Clock();
    const store = new MemoryStore();
    let wakes = 0;
    const scheduler = new ReminderScheduler(
      { workspaceId: "workspace-a", computerId: "computer-a" },
      store,
      async (request) => ({
        ...request,
        result: "accepted",
        fired: true,
        catchup: false,
        [field]: mismatch,
      }),
      async () => {
        wakes++;
        return true;
      },
      clock,
    );
    await scheduler.apply(snapshot([job]));
    await clock.advance(1000);
    await scheduler.awaitIdle();
    expect(wakes).toBe(0);
    expect(store.receipts[0]?.serverResult).toBeUndefined();
    expect(store.receipts[0]?.terminal).toBe(false);
  });
}

test("a newer recurring schedule does not invalidate its pending occurrence", async () => {
  const clock = new Clock();
  let resolve!: (response: ReminderFireResponse) => void;
  let request!: ReminderFireRequest;
  let begin!: () => void;
  const firing = new Promise<void>((done) => (begin = done));
  let wakes = 0;
  const scheduler = new ReminderScheduler(
    { workspaceId: "workspace-a", computerId: "computer-a" },
    new MemoryStore(),
    (sent) =>
      new Promise((done) => {
        begin();
        resolve = done;
        request = sent;
      }),
    async () => {
      wakes++;
      return true;
    },
    clock,
  );
  await scheduler.apply(snapshot([job]));
  await clock.advance(1000);
  await firing;
  await scheduler.apply(change("upsert", 4));
  resolve({ ...request, result: "accepted", fired: true, catchup: false });
  await scheduler.awaitIdle();
  expect(wakes).toBe(1);
});

test("persistence failure is bounded and never sends an uncommitted occurrence", async () => {
  const clock = new Clock();
  let writes = 0;
  let sends = 0;
  const store: ReminderReceiptStore = {
    async read() {
      return [];
    },
    async write() {
      writes++;
      throw new Error("disk full");
    },
  };
  const scheduler = new ReminderScheduler(
    { workspaceId: "workspace-a", computerId: "computer-a" },
    store,
    async (request) => {
      sends++;
      return { ...request, result: "accepted", fired: true, catchup: false };
    },
    async () => true,
    clock,
  );
  await scheduler.apply(snapshot([job]));
  await clock.advance(1000);
  await scheduler.awaitIdle();
  for (let index = 0; index < 8; index++) {
    await clock.advance(60_000);
    await scheduler.awaitIdle();
  }
  expect(writes).toBe(8);
  expect(sends).toBe(0);
  expect(clock.timers).toHaveLength(0);
});

test("a failed attempt write prevents fire until the durable retry", async () => {
  const clock = new Clock();
  const store = new MemoryStore();
  let writes = 0;
  const write = store.write.bind(store);
  store.write = async (agentId, receipts) => {
    writes++;
    if (writes === 2) throw new Error("second write failed");
    await write(agentId, receipts);
  };
  const ids: string[] = [];
  const scheduler = new ReminderScheduler(
    { workspaceId: "workspace-a", computerId: "computer-a" },
    store,
    async (request) => {
      ids.push(request.requestId);
      return { ...request, result: "accepted", fired: false, catchup: false };
    },
    async () => false,
    clock,
  );
  await scheduler.apply(snapshot([job]));
  await clock.advance(1000);
  await scheduler.awaitIdle();
  expect(ids).toEqual([]);
  const requestId = store.receipts[0]!.requestId;
  await clock.advance(999);
  await scheduler.awaitIdle();
  expect(ids).toEqual([]);
  await clock.advance(1);
  await scheduler.awaitIdle();
  expect(ids).toEqual([requestId]);
});

test("an accepted verdict is not woken until its result is durable", async () => {
  const clock = new Clock();
  const store = new MemoryStore();
  let writes = 0;
  const write = store.write.bind(store);
  store.write = async (agentId, receipts) => {
    writes++;
    if (writes === 3) throw new Error("accepted result write failed");
    await write(agentId, receipts);
  };
  let wakes = 0;
  const scheduler = new ReminderScheduler(
    { workspaceId: "workspace-a", computerId: "computer-a" },
    store,
    async (request) => ({ ...request, result: "accepted", fired: true, catchup: false }),
    async () => {
      wakes++;
      return true;
    },
    clock,
  );
  await scheduler.apply(snapshot([job]));
  await clock.advance(1000);
  await scheduler.awaitIdle();
  expect(wakes).toBe(0);
  expect(store.receipts[0]?.serverResult).toBeUndefined();
  await clock.advance(1000);
  await scheduler.awaitIdle();
  expect(wakes).toBe(1);
  expect(store.receipts[0]).toMatchObject({ serverResult: "accepted", wakeAccepted: true });
});

test("a rejected wake waits for each backoff and exhausts the bounded attempt budget", async () => {
  const clock = new Clock();
  const store = new MemoryStore();
  let wakes = 0;
  const scheduler = new ReminderScheduler(
    { workspaceId: "workspace-a", computerId: "computer-a" },
    store,
    async (request) => ({ ...request, result: "accepted", fired: true, catchup: false }),
    async () => {
      wakes++;
      return false;
    },
    clock,
  );
  await scheduler.apply(snapshot([job]));
  await clock.advance(1000);
  await scheduler.awaitIdle();
  expect(wakes).toBe(1);
  await clock.advance(1999);
  await scheduler.awaitIdle();
  expect(wakes).toBe(1);
  await clock.advance(1);
  await scheduler.awaitIdle();
  expect(wakes).toBe(2);
  for (const delay of [4000, 8000, 16_000, 32_000, 60_000]) {
    await clock.advance(delay);
    await scheduler.awaitIdle();
  }
  expect(wakes).toBe(7);
  expect(store.receipts[0]).toMatchObject({ attempt: 8, terminal: true });
  expect(clock.timers).toHaveLength(0);
});

test("a premature delay beyond one budget rearms a fresh authoritative occurrence", async () => {
  const clock = new Clock();
  const store = new MemoryStore();
  const requests: ReminderFireRequest[] = [];
  const retryAfterMs = 16 * 60_000;
  const scheduler = new ReminderScheduler(
    { workspaceId: "workspace-a", computerId: "computer-a" },
    store,
    async (request) => {
      requests.push(request);
      if (requests.length === 1)
        return {
          ...request,
          result: "premature",
          fired: false,
          catchup: false,
          retryAfterMs,
        };
      return { ...request, result: "accepted", fired: false, catchup: false };
    },
    async () => false,
    clock,
  );
  await scheduler.apply(snapshot([job]));
  await clock.advance(1000);
  await scheduler.awaitIdle();
  expect(store.receipts).toEqual([]);
  await clock.advance(retryAfterMs - 1);
  await scheduler.awaitIdle();
  expect(requests).toHaveLength(1);
  await clock.advance(1);
  await scheduler.awaitIdle();
  expect(requests).toHaveLength(2);
  expect(requests[1]!.requestId).not.toBe(requests[0]!.requestId);
  expect(requests[1]!.firedAtClient).not.toBe(requests[0]!.firedAtClient);
  expect(store.receipts[0]?.job).toEqual(job);
  expect(store.receipts[0]!.deadline - Date.parse(store.receipts[0]!.firedAtClient)).toBe(
    15 * 60_000,
  );
});
