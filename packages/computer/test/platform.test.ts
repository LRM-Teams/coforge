import { expect, test } from "bun:test";
import { currentComputerNames } from "../src/platform";

test("uses macOS Computer Name as the display name", () => {
  const commands: string[][] = [];
  expect(
    currentComputerNames({
      platform: "darwin",
      hostname: () => "FrankAn-s-MacBook-Pro.local",
      run: (command) => {
        commands.push(command);
        return "FrankAn’s MacBook Pro\n";
      },
    }),
  ).toEqual({
    name: "FrankAn-s-MacBook-Pro.local",
    displayName: "FrankAn’s MacBook Pro",
  });
  expect(commands).toEqual([["scutil", "--get", "ComputerName"]]);
});

test("uses Linux pretty hostname as the display name", () => {
  expect(
    currentComputerNames({
      platform: "linux",
      hostname: () => "frank-workstation",
      run: () => "Frank’s Workstation\n",
    }),
  ).toEqual({ name: "frank-workstation", displayName: "Frank’s Workstation" });
});

test("uses the Windows computer name and falls back to hostname", () => {
  expect(
    currentComputerNames({
      platform: "win32",
      hostname: () => "frank-pc.local",
      environment: { COMPUTERNAME: "FRANK-PC" },
    }),
  ).toEqual({ name: "frank-pc.local", displayName: "FRANK-PC" });
  expect(
    currentComputerNames({
      platform: "linux",
      hostname: () => "fallback-host",
      run: () => {
        throw new Error("hostnamectl unavailable");
      },
    }),
  ).toEqual({ name: "fallback-host", displayName: "fallback-host" });
});
