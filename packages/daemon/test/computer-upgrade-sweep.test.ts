import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import type { LaunchdJobPlatform } from "../src/platform/launchd-job";
import { sweepLeftoverComputerUpgradeJobs } from "../src/platform/computer-upgrade-sweep";

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

test("removes leftover darwin upgrade jobs whose result file already exists", async () => {
  const root = await mkdtemp("/private/tmp/cf-upgrade-sweep-");
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
});

test("never lists or touches jobs on a non-darwin platform", async () => {
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

test("leaves a job alone when no result file exists yet", async () => {
  const root = await mkdtemp("/private/tmp/cf-upgrade-sweep-");
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
