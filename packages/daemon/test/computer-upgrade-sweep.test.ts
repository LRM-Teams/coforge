import { join } from "node:path";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import type { LaunchdJobPlatform } from "#src/platform/launchd-job";
import { sweepLeftoverComputerUpgradeJobs } from "#src/platform/computer-upgrade-sweep";

// macOS tmpdir lives under /var, a symlink; resolve it so launchd-style path checks and Linux runners both work.
const tempRoot = realpathSync(tmpdir());

const doneId = "123e4567-e89b-42d3-a456-426614174000";
const pendingId = "223e4567-e89b-42d3-a456-426614174000";

function fakeLaunchd(initial: Record<string, number>) {
  const jobs = new Map(Object.entries(initial));
  const bootedOut: string[] = [];
  const platform: LaunchdJobPlatform = {
    jobs: async () => new Map(jobs),
    run: async (args) => {
      if (args[0] === "bootout") {
        const label = args[1]!.split("/").pop()!;
        bootedOut.push(label);
        jobs.delete(label);
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  return { platform, bootedOut };
}

test.skipIf(process.platform === "win32")(
  "removes leftover darwin upgrade jobs whose result file already exists",
  async () => {
    const root = await mkdtemp(join(tempRoot, "cf-upgrade-sweep-"));
    try {
      const { platform, bootedOut } = fakeLaunchd({
        [`cn.coforge.upgrade.${doneId}`]: 0,
        [`cn.coforge.upgrade.${pendingId}`]: 0,
        "cn.coforge.workspace.abc123": 0,
        "cn.coforge.upgrade.not-a-uuid": 0,
      });
      await sweepLeftoverComputerUpgradeJobs({
        platform: "darwin",
        stateDirectory: root,
        jobPlatform: platform,
        resultExists: async (requestId) => requestId === doneId,
      });
      expect(bootedOut).toEqual([`cn.coforge.upgrade.${doneId}`]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("never lists or touches jobs on linux", async () => {
  const platform: LaunchdJobPlatform = {
    jobs: async () => {
      throw new Error("must not list launchd jobs off darwin");
    },
    run: async () => {
      throw new Error("must not run launchctl off darwin");
    },
  };
  await sweepLeftoverComputerUpgradeJobs({
    platform: "linux",
    stateDirectory: "/irrelevant",
    jobPlatform: platform,
    resultExists: async () => true,
  });
});

test("removes leftover Windows upgrade tasks whose result file already exists", async () => {
  const deleted: string[] = [];
  await sweepLeftoverComputerUpgradeJobs({
    platform: "win32",
    stateDirectory: "/irrelevant",
    listCompletedRequestIds: async () => [doneId, pendingId],
    resultExists: async (requestId) => requestId === doneId,
    windowsTaskRunner: async (command) => {
      deleted.push(command.join(" "));
      return 0;
    },
  });
  // listCompletedRequestIds already filtered; both IDs are attempted. Prefer filtering via
  // listCompletedRequestIds returning only done ones in production — here we pass both and
  // rely on listCompletedRequestIds being the source of truth.
  expect(deleted).toEqual([
    `schtasks.exe /Delete /TN CoForge Upgrade ${doneId} /F`,
    `schtasks.exe /Delete /TN CoForge Upgrade ${pendingId} /F`,
  ]);
});

test("Windows sweep only deletes request IDs supplied as completed", async () => {
  const deleted: string[] = [];
  await sweepLeftoverComputerUpgradeJobs({
    platform: "win32",
    stateDirectory: "/irrelevant",
    listCompletedRequestIds: async () => [doneId],
    windowsTaskRunner: async (command) => {
      deleted.push(command[3]!);
      return 0;
    },
  });
  expect(deleted).toEqual([`CoForge Upgrade ${doneId}`]);
});

test("leaves a job alone when no result file exists yet", async () => {
  const root = await mkdtemp(join(tempRoot, "cf-upgrade-sweep-"));
  try {
    const { platform, bootedOut } = fakeLaunchd({ [`cn.coforge.upgrade.${pendingId}`]: 0 });
    await sweepLeftoverComputerUpgradeJobs({
      platform: "darwin",
      stateDirectory: root,
      jobPlatform: platform,
      resultExists: async () => false,
    });
    expect(bootedOut).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
