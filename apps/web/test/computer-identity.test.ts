import { expect, test } from "bun:test";
import { Cloud, Laptop, Monitor, Server } from "lucide-react";

import { computerIcon, computerLabel } from "@/features/computers/computer-identity";

test("a cloud Computer never reads as a machine the User controls", () => {
  const cloud = { kind: "cloud", machineId: "linux:41ab" };

  expect(computerIcon(cloud)).toBe(Cloud);
  expect(computerLabel(cloud)).toBe("Cloud computer");
});

test("a local Computer is pictured by the platform its machine id reports", () => {
  expect(computerIcon({ kind: "local", machineId: "macos:9f2c" })).toBe(Laptop);
  expect(computerIcon({ kind: "local", machineId: "linux:41ab" })).toBe(Server);
  expect(computerIcon({ kind: "local", machineId: "win32:7c1d" })).toBe(Monitor);
  expect(computerLabel({ kind: "local", machineId: "macos:9f2c" })).toBe("macOS");
  expect(computerLabel({ kind: "local", machineId: "win32:7c1d" })).toBe("Windows");
});

test("an unrecognised machine id still names and pictures the Computer", () => {
  const fallback = { kind: "local", machineId: "fallback:2f7e" };

  expect(computerIcon(fallback)).toBe(Monitor);
  expect(computerLabel(fallback)).toBe("Computer");
});
