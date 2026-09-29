import { expect, test } from "bun:test";
import { Cloud01, Monitor01 } from "@untitledui/icons";

import {
  computerIcon,
  computerLabel,
  computerVersionLabel,
} from "#src/features/computers/computer-identity";

test("a cloud Computer never reads as a machine the User controls", () => {
  const cloud = {
    kind: "cloud",
    name: "build-node",
    displayName: "Build Node",
  };

  expect(computerIcon(cloud)).toBe(Cloud01);
  expect(computerLabel(cloud)).toBe("Build Node");
});

test("a local Computer uses its display name rather than machine identity", () => {
  const computer = {
    kind: "local",
    name: "franks-mac",
    displayName: "Frank’s Mac",
  };

  expect(computerIcon(computer)).toBe(Monitor01);
  expect(computerLabel(computer)).toBe("Frank’s Mac");
});

test("an empty display name falls back to the Computer name", () => {
  const fallback = { kind: "local", name: "build-box", displayName: "" };

  expect(computerIcon(fallback)).toBe(Monitor01);
  expect(computerLabel(fallback)).toBe("build-box");
});

test("the version reads as the panel states it, and an unreported one as an em dash", () => {
  // The list row and the detail panel show the same string for the same Computer; only the panel
  // renders the fallback, because the row omits the version when there is nothing to state.
  expect(computerVersionLabel({ computerVersion: "0.1.1-dev.2" })).toBe("0.1.1-dev.2");
  expect(computerVersionLabel({ computerVersion: null })).toBe("—");
  expect(computerVersionLabel({})).toBe("—");
});
