import { expect, test } from "bun:test";
import { join } from "node:path";
import { jobPlist } from "../src/platform/launchd-job";
import {
  computerUpgradeCommand,
  computerUpgradeJobLabel,
  computerUpgradeJobPaths,
  computerUpgradeTaskName,
  deleteWindowsComputerUpgradeTask,
  launchWindowsComputerUpgrade,
  quoteWindowsTaskAction,
} from "../src/platform/computer-upgrade-launcher";

const id = "123e4567-e89b-42d3-a456-426614174000";

test("launches Linux upgrades in an independent user service", () => {
  expect(computerUpgradeCommand("linux", "/coforge-computer", id, "1.2.3")).toEqual([
    "systemd-run",
    "--user",
    "--collect",
    `--unit=coforge-upgrade-${id}.service`,
    "--property=Type=exec",
    "/coforge-computer",
    "__remote-upgrade",
    "--request-id",
    id,
    "--version",
    "1.2.3",
  ]);
});

test("darwin upgrades run the same action inside a one-shot launchd job, never launchctl submit", () => {
  const command = computerUpgradeCommand("darwin", "/coforge-computer", id, "1.2.3");
  expect(command).toEqual([
    "/coforge-computer",
    "__remote-upgrade",
    "--request-id",
    id,
    "--version",
    "1.2.3",
  ]);
  expect(command).not.toContain("submit");
  expect(command).not.toContain("launchctl");
});

test("Windows upgrades use the same action as darwin, never an in-Coordinator spawn argv", () => {
  const command = computerUpgradeCommand("win32", "C:\\Coforge\\coforge-computer.exe", id, "1.2.3");
  expect(command).toEqual([
    "C:\\Coforge\\coforge-computer.exe",
    "__remote-upgrade",
    "--request-id",
    id,
    "--version",
    "1.2.3",
  ]);
  expect(computerUpgradeTaskName(id)).toBe(`CoForge Upgrade ${id}`);
});

test("fails closed on platforms with no safe external coordinator", () => {
  expect(() => computerUpgradeCommand("freebsd", "coforge", id, "1.2.3")).toThrow(
    "no safe external coordinator",
  );
});

test("request-id validation is unchanged", () => {
  expect(() =>
    computerUpgradeCommand("darwin", "/coforge-computer", "not-a-uuid", "1.2.3"),
  ).toThrow("invalid Computer upgrade request ID");
  expect(() => computerUpgradeCommand("linux", "/coforge-computer", "not-a-uuid", "1.2.3")).toThrow(
    "invalid Computer upgrade request ID",
  );
  expect(() => computerUpgradeCommand("darwin", "/coforge-computer", id, "")).toThrow(
    "missing expected Computer release version",
  );
  expect(() => computerUpgradeTaskName("not-a-uuid")).toThrow(
    "invalid Computer upgrade request ID",
  );
});

test("the upgrade job label format is unchanged", () => {
  expect(computerUpgradeJobLabel(id)).toBe(`cn.coforge.upgrade.${id}`);
  expect(() => computerUpgradeJobLabel("not-a-uuid")).toThrow(
    "invalid Computer upgrade request ID",
  );
});

test("the darwin upgrade job's plist and log live under the daemon state and Computer log directories", () => {
  const paths = computerUpgradeJobPaths(id, {
    stateDirectory: "/state/daemon",
    homeDirectory: "/home/frank",
  });
  expect(paths.label).toBe(`cn.coforge.upgrade.${id}`);
  expect(paths.directory).toBe(join("/state/daemon", "upgrade-jobs"));
  expect(paths.logPath).toBe(
    join("/home/frank", ".coforge", "computer", "logs", "computer", `upgrade-${id}.log`),
  );
});

test("the generated darwin upgrade plist runs once at load and is never kept alive", () => {
  const paths = computerUpgradeJobPaths(id, {
    stateDirectory: "/state/daemon",
    homeDirectory: "/home/frank",
  });
  const plist = jobPlist({
    label: paths.label,
    directory: paths.directory,
    command: computerUpgradeCommand("darwin", "/coforge-computer", id, "1.2.3"),
    logPath: paths.logPath,
  });
  expect(plist).toContain(`<key>Label</key><string>${paths.label}</string>`);
  expect(plist).toContain("<key>RunAtLoad</key><true/>");
  expect(plist).not.toContain("KeepAlive");
  expect(plist).toContain(`<key>StandardOutPath</key><string>${paths.logPath}</string>`);
  expect(plist).toContain(`<key>StandardErrorPath</key><string>${paths.logPath}</string>`);
});

test("Windows upgrade schtasks Create+Run uses a quoted executable and far-future ONCE placeholder", async () => {
  const calls: string[][] = [];
  const action = computerUpgradeCommand(
    "win32",
    "C:\\Path With Space\\coforge-computer.exe",
    id,
    "9.9.9",
  );
  await launchWindowsComputerUpgrade(id, action, async (command) => {
    calls.push(command);
    return 0;
  });
  expect(calls).toHaveLength(2);
  expect(calls[0]).toEqual([
    "schtasks.exe",
    "/Create",
    "/TN",
    `CoForge Upgrade ${id}`,
    "/TR",
    quoteWindowsTaskAction(action),
    "/SC",
    "ONCE",
    "/ST",
    "00:00",
    "/SD",
    "01/01/2099",
    "/F",
    "/RL",
    "LIMITED",
  ]);
  expect(calls[0]![5]).toContain('"C:\\Path With Space\\coforge-computer.exe"');
  expect(calls[0]![5]).toContain("__remote-upgrade");
  expect(calls[1]).toEqual(["schtasks.exe", "/Run", "/TN", `CoForge Upgrade ${id}`]);
});

test("Windows upgrade Create failure is rejected before Run", async () => {
  await expect(
    launchWindowsComputerUpgrade(id, ["coforge-computer.exe", "__remote-upgrade"], async () => 1),
  ).rejects.toThrow("external Computer upgrade coordinator was rejected");
});

test("Windows upgrade cleanup deletes the Scheduled Task", async () => {
  const calls: string[][] = [];
  await deleteWindowsComputerUpgradeTask(id, async (command) => {
    calls.push(command);
    return 0;
  });
  expect(calls).toEqual([["schtasks.exe", "/Delete", "/TN", `CoForge Upgrade ${id}`, "/F"]]);
});
