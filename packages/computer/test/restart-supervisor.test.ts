import { expect, test } from "bun:test";
import {
  restartSupervisor,
  type RestartSupervisorHost,
  type RestartSupervisorLocal,
} from "../src/cli";

function fakeLocal(overrides: Partial<RestartSupervisorLocal> = {}): RestartSupervisorLocal & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    async identity() {
      calls.push("identity");
      return { daemonId: "d" };
    },
    async hold(operation) {
      calls.push(`hold:${operation}`);
      return { accepted: true, busyAgents: [] };
    },
    ...overrides,
  };
}

test("restart --supervisor holds runners, restarts, then releases the hold, in that order", async () => {
  const output: string[] = [];
  const local = fakeLocal();
  const host: RestartSupervisorHost = {
    async restart() {
      local.calls.push("restart");
    },
  };

  await restartSupervisor(host, local, { stdout: (line) => output.push(line) });

  expect(local.calls).toEqual(["identity", "hold:hold", "restart", "hold:release"]);
  expect(output.some((line) => line.includes("Restarting the Computer supervisor"))).toBe(true);
});

test("restart --supervisor skips the hold and restarts anyway when the Coordinator is unreachable", async () => {
  const output: string[] = [];
  const calls: string[] = [];
  const local: RestartSupervisorLocal = {
    async identity() {
      throw new Error("ECONNREFUSED");
    },
    async hold(operation) {
      calls.push(`hold:${operation}`);
      return { accepted: true, busyAgents: [] };
    },
  };
  const host: RestartSupervisorHost = {
    async restart() {
      calls.push("restart");
    },
  };

  await restartSupervisor(host, local, { stdout: (line) => output.push(line) });

  expect(calls).toEqual(["restart"]);
  expect(output.some((line) => line.includes("unreachable"))).toBe(true);
});

test("restart --supervisor refuses a foreground externally supervised Computer without restarting", async () => {
  const local = fakeLocal();
  let restarted = false;
  const host: RestartSupervisorHost = {
    async assertRestartable() {
      throw new Error("launchctl print failed (113)");
    },
    async restart() {
      restarted = true;
    },
  };

  await expect(restartSupervisor(host, local, { stdout: () => {} })).rejects.toThrow(
    "Cannot restart the supervisor of a foreground externally supervised Computer",
  );
  expect(restarted).toBe(false);
  expect(local.calls).toEqual([]);
});

test("restart --supervisor on a host with no in-place restartability check wraps any restart failure as the foreground case", async () => {
  const local = fakeLocal();
  const host: RestartSupervisorHost = {
    async restart() {
      throw new Error("could not restart the CoForge Daemon user service");
    },
  };

  await expect(restartSupervisor(host, local, { stdout: () => {} })).rejects.toThrow(
    "Cannot restart the supervisor of a foreground externally supervised Computer",
  );
});

test("restart --supervisor on a launchd host rethrows a restart failure unchanged once restartability is confirmed", async () => {
  const local = fakeLocal();
  const host: RestartSupervisorHost = {
    async assertRestartable() {},
    async restart() {
      throw new Error("launchctl kickstart failed (37)");
    },
  };

  await expect(restartSupervisor(host, local, { stdout: () => {} })).rejects.toThrow(
    "launchctl kickstart failed (37)",
  );
});

test("restart --supervisor releases the hold even when the restart itself fails", async () => {
  const local = fakeLocal();
  const host: RestartSupervisorHost = {
    async assertRestartable() {},
    async restart() {
      local.calls.push("restart");
      throw new Error("launchctl kickstart failed (1)");
    },
  };

  await expect(restartSupervisor(host, local, { stdout: () => {} })).rejects.toThrow(
    "launchctl kickstart failed (1)",
  );
  expect(local.calls).toEqual(["identity", "hold:hold", "restart", "hold:release"]);
});
