import { expect, test } from "bun:test";
import { parseWindowsTaskQuery, probeWindowsCoordinator } from "#src/status/windows-status-ports";

test("parseWindowsTaskQuery treats a successful LIST dump as loaded", () => {
  expect(
    parseWindowsTaskQuery(`
TaskName:                             \\CoForge Daemon
Status:                               Running
Last Result:                          0
`),
  ).toEqual({ loaded: true, running: true });
  expect(
    parseWindowsTaskQuery(`
TaskName:                             \\CoForge Daemon
Status:                               Ready
Last Result:                          0
`),
  ).toEqual({ loaded: true, running: false });
});

test("parseWindowsTaskQuery recognizes localized Running status tokens", () => {
  expect(
    parseWindowsTaskQuery(`
任务名:                               \\CoForge Daemon
状态:                                 正在运行
上次结果:                             0
`),
  ).toEqual({ loaded: true, running: true });
});

test("probeWindowsCoordinator reports the task missing when Query fails", async () => {
  await expect(
    probeWindowsCoordinator("missing", {
      query: async () => ({ code: 1, stdout: "" }),
      resolvePid: async () => 42,
    }),
  ).resolves.toEqual({ loaded: false, pid: null });
});

test("probeWindowsCoordinator resolves PID only when the task is running", async () => {
  await expect(
    probeWindowsCoordinator("CoForge Daemon", {
      query: async () => ({
        code: 0,
        stdout: "TaskName: \\CoForge Daemon\r\nStatus: Running\r\n",
      }),
      resolvePid: async () => 4821,
    }),
  ).resolves.toEqual({ loaded: true, pid: 4821 });

  await expect(
    probeWindowsCoordinator("CoForge Daemon", {
      query: async () => ({
        code: 0,
        stdout: "TaskName: \\CoForge Daemon\r\nStatus: Ready\r\n",
      }),
      resolvePid: async () => 4821,
    }),
  ).resolves.toEqual({ loaded: true, pid: null });
});
