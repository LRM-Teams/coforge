import { expect, test } from "bun:test";
import { Cloud, Monitor } from "lucide-react";

import { computerIcon, computerLabel } from "@/features/computers/computer-identity";

test("a cloud Computer never reads as a machine the User controls", () => {
  const cloud = { kind: "cloud", name: "build-node", displayName: "Build Node" };

  expect(computerIcon(cloud)).toBe(Cloud);
  expect(computerLabel(cloud)).toBe("Build Node");
});

test("a local Computer uses its display name rather than machine identity", () => {
  const computer = { kind: "local", name: "franks-mac", displayName: "Frank’s Mac" };

  expect(computerIcon(computer)).toBe(Monitor);
  expect(computerLabel(computer)).toBe("Frank’s Mac");
});

test("an empty display name falls back to the Computer name", () => {
  const fallback = { kind: "local", name: "build-box", displayName: "" };

  expect(computerIcon(fallback)).toBe(Monitor);
  expect(computerLabel(fallback)).toBe("build-box");
});
