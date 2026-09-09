import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { LaunchdJob } from "../src/platform/launchd-job";

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
