import { expect, test } from "bun:test";
import { rejection } from "./rejection";
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

  const error = await rejection(restartSupervisor(host, local, { stdout: () => {} }));
  expect(error.message).toContain("foreground externally supervised Computer");
  expect(error.message).toContain("launchctl print failed (113)");
  expect(error.message).toContain("coforge-computer start");
  expect(restarted).toBe(false);
  expect(local.calls).toEqual([]);
});

test("restart --supervisor keeps the reason a host without an in-place restartability check reported", async () => {
  const local = fakeLocal();
  const host: RestartSupervisorHost = {
    async restart() {
      throw new Error(
        "`systemctl --user restart coforge-daemon.service` failed (1): Failed to connect to bus: No medium found. This shell has no systemd user session.",
      );
    },
  };

  const error = await rejection(restartSupervisor(host, local, { stdout: () => {} }));
  expect(error.message).toContain("Failed to connect to bus: No medium found");
  expect(error.message).toContain("no systemd user session");
  expect(error.message).not.toContain("foreground externally supervised");
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
