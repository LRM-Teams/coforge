import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { configure, reset, type LogRecord } from "@logtape/logtape";
import { LaunchdJob } from "../src/platform/launchd-job";

async function captureDaemonLogs<T>(operation: () => Promise<T>): Promise<LogRecord[]> {
  const records: LogRecord[] = [];
  await configure({
    reset: true,
    sinks: { capture: (record) => void records.push(record) },
    loggers: [
      { category: ["coforge", "daemon"], lowestLevel: "info", sinks: ["capture"] },
      { category: ["logtape", "meta"], lowestLevel: "error", sinks: ["capture"] },
    ],
  });
  try {
    await operation();
  } finally {
    await reset();
  }
  return records;
}

// Regression: the 09:17 coordinator crash reported only `exit_code: 125`, because
// launchctl's own explanation was discarded before it could be logged.
test("a failed bootout reports what launchctl said and still fails the stop", async () => {
  const label = "cn.coforge.test.bootout";
  const job = new LaunchdJob({
    label,
    directory: "/private/tmp/coforge-test-bootout",
    command: ["/bin/sleep", "1"],
    platform: {
      jobs: async () => new Map([[label, 0]]),
      run: async () => ({
        code: 125,
        stdout: "",
        stderr: "Boot-out failed: 125: Operation canceled\n",
      }),
    },
  });
  const records = await captureDaemonLogs(async () => {
    await expect(job.stop()).rejects.toThrow(
      /launchctl bootout failed \(125\): Boot-out failed: 125: Operation canceled/,
    );
  });
  expect(
    records.find((record) => record.properties.event === "launchd:command_failed"),
  ).toMatchObject({
    properties: {
      operation: "bootout",
      exit_code: 125,
      error_message: "Boot-out failed: 125: Operation canceled",
    },
  });
});

test("a failed bootout whose job is already gone stays tolerated", async () => {
  const label = "cn.coforge.test.bootout-gone";
  let listed = true;
  const job = new LaunchdJob({
    label,
    directory: "/private/tmp/coforge-test-bootout",
    command: ["/bin/sleep", "1"],
    platform: {
      jobs: async () => {
        const current = listed ? new Map([[label, 0]]) : new Map<string, number>();
        listed = false;
        return current;
      },
      run: async () => ({ code: 125, stdout: "", stderr: "Boot-out failed: 125\n" }),
    },
  });
  await job.stop();
});

test.skipIf(process.platform !== "darwin")(
  "user job start is idempotent and stop removes its process group",
  async () => {
    const root = await mkdtemp("/private/tmp/coforge-job-");
    const job = new LaunchdJob({
      label: `cn.coforge.test.${crypto.randomUUID()}`,
      directory: root,
      command: ["/bin/sleep", "300"],
    });
    try {
      const first = await job.ensureStarted();
      expect(first.mainPid).toBeGreaterThan(0);
      expect(first.invocationId).not.toBe(String(first.mainPid));
      expect(await job.ensureStarted()).toEqual(first);
      await Promise.all([job.stop(), job.stop()]);
      expect(await job.identity()).toBeNull();
      expect(() => process.kill(first.mainPid, 0)).toThrow();
    } finally {
      await job.stop();
      await rm(root, { recursive: true, force: true });
    }
  },
);
