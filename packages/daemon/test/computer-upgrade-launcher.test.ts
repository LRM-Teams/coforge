import { expect, test } from "bun:test";
import { jobPlist } from "../src/platform/launchd-job";
import {
  computerUpgradeCommand,
  computerUpgradeJobLabel,
  computerUpgradeJobPaths,
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

test("fails closed on platforms with no safe external coordinator", () => {
  expect(() => computerUpgradeCommand("win32", "coforge.exe", id, "1.2.3")).toThrow(
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
  expect(paths.directory).toBe("/state/daemon/upgrade-jobs");
  expect(paths.logPath).toBe(`/home/frank/.coforge/computer/logs/computer/upgrade-${id}.log`);
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
