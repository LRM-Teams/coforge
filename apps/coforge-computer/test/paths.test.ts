import { expect, test } from "bun:test";

import { resolveComputerConfigDirectory, resolveComputerStateDirectory } from "../src/paths";

test("Linux uses XDG_CONFIG_HOME for Computer configuration", () => {
  expect(
    resolveComputerConfigDirectory({
      platform: "linux",
      homeDirectory: "/home/alice",
      environment: { XDG_CONFIG_HOME: "/config/alice" },
    }),
  ).toBe("/config/alice/coforge");
});

test("Linux falls back to the XDG config default", () => {
  expect(
    resolveComputerConfigDirectory({
      platform: "linux",
      homeDirectory: "/home/alice",
      environment: {},
    }),
  ).toBe("/home/alice/.config/coforge");
});

test("macOS configuration uses Application Support", () => {
  expect(
    resolveComputerConfigDirectory({
      platform: "darwin",
      homeDirectory: "/Users/alice",
      environment: {},
    }),
  ).toBe("/Users/alice/Library/Application Support/Coforge");
});

test("Windows configuration uses LOCALAPPDATA", () => {
  expect(
    resolveComputerConfigDirectory({
      platform: "win32",
      homeDirectory: "C:\\Users\\alice",
      environment: { LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local" },
    }),
  ).toBe("C:\\Users\\alice\\AppData\\Local\\Coforge");
});

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
