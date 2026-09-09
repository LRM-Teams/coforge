import { expect, test } from "bun:test";
import { readOperatingSystem } from "../src/platform/operating-system";

test("reports macOS product version rather than Darwin kernel version", () => {
  expect(
    readOperatingSystem({
      platform: "darwin",
      release: () => "25.1.0",
      run: (cmd) => {
        expect(cmd).toEqual(["/usr/bin/sw_vers", "-productVersion"]);
        return "26.1\n";
      },
    }),
  ).toEqual({ platform: "darwin", osVersion: "26.1" });
});

test("failed macOS detection is unknown, never a mislabeled kernel", () => {
  expect(
    readOperatingSystem({
      platform: "darwin",
      release: () => "25.1.0",
      run: () => {
        throw new Error("missing");
      },
    }),
  ).toEqual({ platform: "darwin", osVersion: "" });
});

test("Linux and Windows report OS release and unsupported systems remain unknown", () => {
  expect(readOperatingSystem({ platform: "linux", release: () => "6.12.9" })).toEqual({
    platform: "linux",
    osVersion: "6.12.9",
  });
  expect(readOperatingSystem({ platform: "win32", release: () => "10.0.26100" })).toEqual({
    platform: "win32",
    osVersion: "10.0.26100",
  });
  expect(readOperatingSystem({ platform: "freebsd" })).toEqual({ platform: "", osVersion: "" });
});
