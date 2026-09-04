import { expect, test } from "bun:test";

import { isReleaseTarget, resolveBunCompileTarget } from "./compile-targets";

// Compiling is slow, so this file only covers the pure target-name mapping - never calls
// compileTargetArtifacts() or Bun.build(). See build-release.test.ts for the real end-to-end
// coverage, using small fake binaries in place of a compiled one.

test("every release target used by updater.ts, install.sh and install.ps1 maps to a bun-<os>-<arch> compile target", () => {
  const targets = [
    "linux-x64",
    "linux-arm64",
    "darwin-x64",
    "darwin-arm64",
    "windows-x64",
    "windows-arm64",
  ];
  for (const target of targets) {
    expect(isReleaseTarget(target)).toBe(true);
    expect(resolveBunCompileTarget(target)).toBe(`bun-${target}`);
  }
});

test("an unsupported target throws instead of silently resolving to nothing", () => {
  for (const invalid of ["linux-x86", "windows", "", "linux-x64 ", "LINUX-X64"]) {
    expect(isReleaseTarget(invalid)).toBe(false);
    expect(() => resolveBunCompileTarget(invalid)).toThrow(/unsupported release target/);
  }
});
