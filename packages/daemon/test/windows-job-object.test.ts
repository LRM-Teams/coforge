import { expect, test } from "bun:test";

import {
  createWindowsJobObject,
  windowsJobObjectsAvailable,
} from "../src/platform/windows-job-object";

test.skipIf(process.platform !== "win32")("Job Object reports active process count", async () => {
  expect(windowsJobObjectsAvailable()).toBe(true);
  const job = createWindowsJobObject();
  try {
    expect(job.activeProcesses()).toBe(0);
    const child = Bun.spawn({
      cmd: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    const pid = child.pid;
    expect(pid).toBeGreaterThan(0);
    job.assign(pid!);
    expect(job.activeProcesses()).toBe(1);
    job.terminate(1);
    const deadline = Date.now() + 2_000;
    while (job.activeProcesses() > 0 && Date.now() < deadline) await Bun.sleep(20);
    expect(job.activeProcesses()).toBe(0);
    await child.exited;
  } finally {
    job.close();
  }
});

test("Job Object factory is unavailable off Windows", () => {
  if (process.platform === "win32") return;
  expect(windowsJobObjectsAvailable()).toBe(false);
});
