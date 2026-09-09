import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReminderScheduler, type ReminderReceipt } from "../src/agent-reminder/reminder-scheduler";
import { FileReminderReceiptStore } from "../src/persistence/reminder-receipt-store";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const storedReceipt = (computerId = "computer-a"): ReminderReceipt => ({
  workspaceId: "workspace-a",
  computerId,
  agentId: "agent-a",
  reminderId: "123e4567-e89b-42d3-a456-426614174000",
  version: 1,
  job: {
    reminderId: "123e4567-e89b-42d3-a456-426614174000",
    ownerAgentId: "agent-a",
    version: 1,
    title: "Review",
    target: "@frank",
    messageId: "123e4567-e89b-42d3-a456-426614174001",
    fireAt: "2026-09-08T12:00:01Z",
  },
  requestId: crypto.randomUUID(),
  firedAtClient: "2026-09-08T12:00:01Z",
  attempt: 1,
  deadline: Date.now() + 60_000,
  nextAt: Date.now(),
  serverResult: "accepted",
  serverFired: true,
  serverCatchup: false,
  wakeAccepted: false,
  consumed: false,
  terminal: false,
});

test("a reopened receipt store rejects state persisted for another Computer before restore wakes", async () => {
  const directory = join(tmpdir(), `coforge-reminder-receipts-${crypto.randomUUID()}`);
  directories.push(directory);
  await new FileReminderReceiptStore(directory, "workspace-a", "computer-a").write("agent-a", [
    storedReceipt(),
  ]);
  const wrongComputerStore = new FileReminderReceiptStore(directory, "workspace-a", "computer-b");
  let wakes = 0;
  const scheduler = new ReminderScheduler(
    { workspaceId: "workspace-a", computerId: "computer-b" },
    wrongComputerStore,
    async () => {
      throw new Error("must not fire");
    },
    async () => {
      wakes++;
      return true;
    },
  );
  await scheduler.apply({
    protocolMajor: 1,
    requestId: crypto.randomUUID(),
    workspaceId: "workspace-a",
    computerId: "computer-b",
    agentId: "agent-a",
    operation: "snapshot",
    jobs: [],
    messageType: "coforge.rpc.v1.ReminderSync",
  });
  await scheduler.awaitIdle();
  expect(wakes).toBe(0);
  await expect(wrongComputerStore.read("agent-a")).rejects.toThrow("corrupt");
  scheduler.stop();
});

test("receipt persistence rejects malformed, duplicate, and inconsistent accepted state", async () => {
  const directory = join(tmpdir(), `coforge-reminder-receipts-${crypto.randomUUID()}`);
  directories.push(directory);
  const store = new FileReminderReceiptStore(directory, "workspace-a", "computer-a");
  const valid = storedReceipt();
  await expect(store.write("agent-a", [valid, valid])).rejects.toThrow("corrupt");
  await expect(store.write("agent-a", [{ ...valid, deadline: Number.NaN }])).rejects.toThrow(
    "corrupt",
  );
  await expect(store.write("agent-a", [{ ...valid, wakeAccepted: true }])).rejects.toThrow(
    "corrupt",
  );
});
