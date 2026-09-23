import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalDaemonLauncher } from "@lrm/coforge-daemon";
import { isReleaseTarget, resolveBunCompileTarget } from "./compile-targets";

/** Where a test builds and runs the published executable. macOS needs a short, symlink-free
 * root: `os.tmpdir()` sits under the `/var -> /private/var` link the Daemon's log-path check
 * rejects, and the per-user `/var/folders/...` prefix pushes the `clean-home` socket path past
 * the 104-byte `sun_path` limit, where `connect(2)` fails with EINVAL instead of ENOENT. */
function temporaryRoot(): string {
  return process.platform === "darwin" ? "/private/tmp" : tmpdir();
}

/** Bun's in-process Mach-O signer wrote an invalid ad-hoc signature before 1.4.2. macOS 26
 * still ran those executables; macOS 27 kills them at launch with OS_REASON_CODESIGNING, so a
 * strict `codesign` verification is the one check that catches the regression on any macOS. */
function expectValidMacOsSignature(executable: string): void {
  if (process.platform !== "darwin") return;
  const verify = Bun.spawnSync(["/usr/bin/codesign", "--verify", "--strict", executable], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(verify.stderr.toString()).toBe("");
  expect(verify.exitCode).toBe(0);
}

test.each([
  ["https://releases-staging.coforge.cn", "https://staging.coforge.cn"],
  ["https://releases.coforge.cn", "https://coforge.cn"],
])(
  "published Computer %s keeps its compiled identity and login server",
  async (feedUrl, serverUrl) => {
    const target = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
    if (!isReleaseTarget(target)) throw new Error(`unsupported test host: ${target}`);
    // An explicit artifact root transfers cleanup ownership to the calling CI job.
    const artifactRoot = Bun.env.COFORGE_RELEASE_TEST_ARTIFACT_ROOT;
    const directory = await mkdtemp(
      join(artifactRoot ?? temporaryRoot(), "coforge-release-version-"),
    );
    try {
      const options = {
        target,
        version: "9.8.7-rc.6",
        feedUrl,
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
      expectValidMacOsSignature(executable);
      // Await the worker's OS exit and drain its pipes before inspecting results.
      const probe = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "fixtures/probe-release-environment.ts"),
          executable,
          directory,
          serverUrl,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [probeCode, probeOutput, probeError] = await Promise.all([
        probe.exited,
        new Response(probe.stdout).text(),
        new Response(probe.stderr).text(),
      ]);
      expect(probeError).toBe("");
      expect(probeCode).toBe(0);
      const observed = JSON.parse(probeOutput);
      expect(observed.version.exitCode).toBe(0);
      expect(observed.version.stdout).toBe("9.8.7-rc.6\n");
      expect(observed.version.stderr).toBe("");
      expect(observed.daemonCode).toBe(1);
      expect(observed.daemonOutput).toBe("");
      expect(observed.daemonError).toContain("does not match this daemon build");
      expect(observed.code).toBe(1);
      expect(observed.stdout + observed.stderr).toContain(serverUrl);
      // The proxy rejects the tunnel; this checks routing, not login success.
      expect(observed.stdout + observed.stderr).toContain("AUTH_FAILED");
      expect(observed.requests.join("\n")).toContain(`CONNECT ${new URL(serverUrl).hostname}:443`);
      expect(observed.requests.join("\n")).not.toContain("invalid.example");
    } finally {
      // Hosted Windows processes can briefly open the executable without sharing
      // deletion, even after our worker exits. runner.temp owns CI disposal;
      // local runs still remove their own fixtures and surface cleanup errors.
      if (!artifactRoot) await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
test("published unified Computer runs management, Daemon, and Agent modes from one executable", async () => {
  const target = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
  if (!isReleaseTarget(target)) throw new Error(`unsupported test host: ${target}`);
  const directory = await mkdtemp(join(temporaryRoot(), "coforge-unified-executable-"));
  const outputDirectory = join(directory, "artifacts");
  try {
    const options = {
      target,
      version: "9.8.7-rc.6",
      feedUrl: "https://releases-staging.coforge.cn",
      outputDirectory,
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
      outputDirectory,
      `${target}-coforge-computer${process.platform === "win32" ? ".exe" : ""}`,
    );
    expect(await readdir(outputDirectory)).toEqual([
      `${target}-coforge-computer${process.platform === "win32" ? ".exe" : ""}`,
    ]);
    expectValidMacOsSignature(executable);

    const management = Bun.spawnSync([executable, "--cli-version"], {
      env: { ...Bun.env, COFORGE_COMPUTER_VERSION: "0.0.0-wrong" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(management.exitCode).toBe(0);
    expect(management.stdout.toString()).toBe("9.8.7-rc.6\n");
    expect(management.stderr.toString()).toBe("");

    const isolatedHome = join(directory, "agent-home");
    const agent = Bun.spawnSync([executable, "__agent-cli"], {
      env: {
        ...Bun.env,
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
        COFORGE_DAEMON_HOME: join(directory, "agent-daemon-state"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(agent.exitCode).toBe(1);
    expect(agent.stderr.toString()).toStartWith("Usage: coforge ");
    expect(await readdir(directory)).toEqual(["artifacts"]);

    const socketPath = join(directory, "daemon.sock");
    const daemon = Bun.spawn(
      [
        executable,
        "__daemon",
        "--socket",
        socketPath,
        "--state-directory",
        join(directory, "daemon-state"),
      ],
      {
        env: { ...Bun.env, COFORGE_DAEMON_VERSION: "0.0.0-wrong" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      const launcher = new LocalDaemonLauncher({
        executablePath: "/unused",
        socketPath,
        serverUrl: "https://staging.coforge.cn",
        spawn: () => {},
      });
      await launcher.ensureRunning();
      expect(await launcher.identity()).toMatchObject({
        version: "9.8.7-rc.6",
        processId: daemon.pid,
      });
    } finally {
      daemon.kill();
      await daemon.exited;
    }
    expect(await new Response(daemon.stdout).text()).toBe("");
    expect(await new Response(daemon.stderr).text()).toBe("");
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
