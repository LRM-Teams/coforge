import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isReleaseTarget, resolveBunCompileTarget } from "./compile-targets";

test("published Computer reports its compiled release version, not a runtime override", async () => {
  const target = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
  if (!isReleaseTarget(target)) throw new Error(`unsupported test host: ${target}`);
  const directory = await mkdtemp(join(tmpdir(), "coforge-release-version-"));
  try {
    const options = {
      target,
      version: "9.8.7-rc.6",
      feedUrl: "https://releases-staging.coforge.cn",
      outputDirectory: directory,
    };
    // Build outside bun:test so its module resolver and mocks cannot affect release compilation.
    const build = Bun.spawnSync(
      [
        process.execPath,
        "--eval",
        `import { compileTargetArtifacts } from ${JSON.stringify(join(import.meta.dir, "compile-targets.ts"))}; await compileTargetArtifacts(${JSON.stringify(options)});`,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(build.stderr.toString()).toBe("");
    expect(build.exitCode).toBe(0);
    const executable = join(
      directory,
      `${target}-coforge-computer${process.platform === "win32" ? ".exe" : ""}`,
    );
    const result = Bun.spawnSync([executable, "--cli-version"], {
      env: { ...Bun.env, COFORGE_COMPUTER_VERSION: "0.0.0-wrong" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("9.8.7-rc.6\n");
    expect(result.stderr.toString()).toBe("");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

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
    // Compared as a plain string: the return type is a union of the six literals, which a
    // `bun-${string}` template type is not assignable to.
    expect(String(resolveBunCompileTarget(target))).toBe(`bun-${target}`);
  }
});

test("an unsupported target throws instead of silently resolving to nothing", () => {
  for (const invalid of ["linux-x86", "windows", "", "linux-x64 ", "LINUX-X64"]) {
    expect(isReleaseTarget(invalid)).toBe(false);
    expect(() => resolveBunCompileTarget(invalid)).toThrow(/unsupported release target/);
  }
});
