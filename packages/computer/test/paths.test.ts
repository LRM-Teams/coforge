import { expect, test } from "bun:test";

import {
  resolveComputerBinaryDirectory,
  resolveComputerConfigDirectory,
  resolveComputerCredentialsDirectory,
  resolveComputerInstallDirectory,
  resolveComputerStateDirectory,
} from "../src/paths";

test("Computer and Daemon use separate directories under the user's .coforge directory", () => {
  const input = { platform: "linux" as const, homeDirectory: "/home/alice", environment: {} };
  expect(resolveComputerConfigDirectory(input)).toBe("/home/alice/.coforge/computer");
  expect(resolveComputerStateDirectory(input)).toBe("/home/alice/.coforge/daemon");
});

test("credential environment variables select the credential root", () => {
  const input = {
    platform: "linux" as const,
    homeDirectory: "/home/alice",
    environment: {
      COFORGE_COMPUTER_CREDENTIALS_DIR: "/secure/credentials",
      COFORGE_COMPUTER_HOME: "/state/computer",
    },
  };
  expect(resolveComputerCredentialsDirectory(input)).toBe("/secure/credentials");
  expect(
    resolveComputerCredentialsDirectory({
      ...input,
      environment: { COFORGE_COMPUTER_HOME: "/state/computer" },
    }),
  ).toBe("/state/computer/credentials");
});

test("Windows uses the user's .coforge directory", () => {
  const input = {
    platform: "win32" as const,
    homeDirectory: "C:\\Users\\alice",
    environment: { LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local" },
  };
  expect(resolveComputerConfigDirectory(input)).toBe("C:\\Users\\alice\\.coforge\\computer");
  expect(resolveComputerStateDirectory(input)).toBe("C:\\Users\\alice\\.coforge\\daemon");
});

test("Computer installation paths stay under its directory", () => {
  const input = { platform: "linux" as const, homeDirectory: "/home/alice", environment: {} };
  expect(resolveComputerInstallDirectory(input)).toBe("/home/alice/.coforge/computer/install");
});

test("the shim directory is the XDG user binary directory, not the private root", () => {
  for (const platform of ["linux", "darwin"] as const) {
    const input = { platform, homeDirectory: "/home/alice", environment: {} };
    expect(resolveComputerBinaryDirectory(input)).toBe("/home/alice/.local/bin");
    expect(
      resolveComputerBinaryDirectory({
        ...input,
        environment: { XDG_BIN_HOME: "/home/alice/bin" },
      }),
    ).toBe("/home/alice/bin");
    // A relative XDG_BIN_HOME is not a usable PATH entry, so the default stands.
    expect(resolveComputerBinaryDirectory({ ...input, environment: { XDG_BIN_HOME: "bin" } })).toBe(
      "/home/alice/.local/bin",
    );
  }
  expect(
    resolveComputerBinaryDirectory({
      platform: "win32",
      homeDirectory: "C:\\Users\\alice",
      environment: { LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local" },
    }),
  ).toBe("C:\\Users\\alice\\.coforge\\computer\\bin");
});
