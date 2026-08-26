import { expect, test } from "bun:test";

import { resolveComputerStateDirectory } from "../src/paths";

test("Linux uses XDG_STATE_HOME for daemon state", () => {
  expect(
    resolveComputerStateDirectory({
      platform: "linux",
      homeDirectory: "/home/alice",
      environment: { XDG_STATE_HOME: "/state/alice" },
    }),
  ).toBe("/state/alice/coforge");
});

test("Linux falls back to the XDG state default", () => {
  expect(
    resolveComputerStateDirectory({
      platform: "linux",
      homeDirectory: "/home/alice",
      environment: {},
    }),
  ).toBe("/home/alice/.local/state/coforge");
});

test("macOS uses Application Support", () => {
  expect(
    resolveComputerStateDirectory({
      platform: "darwin",
      homeDirectory: "/Users/alice",
      environment: {},
    }),
  ).toBe("/Users/alice/Library/Application Support/Coforge");
});

test("Windows uses LOCALAPPDATA", () => {
  expect(
    resolveComputerStateDirectory({
      platform: "win32",
      homeDirectory: "C:\\Users\\alice",
      environment: { LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local" },
    }),
  ).toBe("C:\\Users\\alice\\AppData\\Local\\Coforge");
});
