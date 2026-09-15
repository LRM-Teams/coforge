import { expect, test } from "bun:test";
import { computerUpgradeCommand } from "../src/platform/computer-upgrade-launcher";

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

test("launches macOS upgrades in an independent launchd job and fails closed elsewhere", () => {
  expect(computerUpgradeCommand("darwin", "/coforge-computer", id, "1.2.3")).toEqual([
    "launchctl",
    "submit",
    "-l",
    `cn.coforge.upgrade.${id}`,
    "--",
    "/coforge-computer",
    "__remote-upgrade",
    "--request-id",
    id,
    "--version",
    "1.2.3",
  ]);
  expect(() => computerUpgradeCommand("win32", "coforge.exe", id, "1.2.3")).toThrow(
    "no safe external coordinator",
  );
});
