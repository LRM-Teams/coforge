import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalDaemonLauncher } from "../../packages/daemon";
import { isReleaseTarget, resolveBunCompileTarget } from "./compile-targets";

test.each([
  ["https://releases-staging.coforge.cn", "https://staging.coforge.cn"],
  ["https://releases.coforge.cn", "https://coforge.cn"],
])(
  "published Computer %s keeps its compiled identity and login server",
  async (feedUrl, serverUrl) => {
    const target = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
    if (!isReleaseTarget(target)) throw new Error(`unsupported test host: ${target}`);
    const directory = await mkdtemp(join(tmpdir(), "coforge-release-version-"));
    const executable = join(
      directory,
      `${target}-coforge-computer${process.platform === "win32" ? ".exe" : ""}`,
    );
    const processes: Record<string, unknown> = { testPid: process.pid };
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
      // Keep executable handles in a worker whose OS lifetime we can await.
      // Bun's exited subprocess handles otherwise remain owned by the test VM.
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
      processes.worker = { pid: probe.pid, exitCode: probeCode, pipesDrained: true };
      expect(probeError).toBe("");
      expect(probeCode).toBe(0);
      const observed = JSON.parse(probeOutput);
      processes.children = observed.processes;
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
      try {
        // Bun's direct unlink uses libuv on Windows; recursive rm uses a
        // different native deletion path. Delete the known executable directly
        // after its worker exits, retaining strict cleanup without retries.
        if (process.platform === "win32" && (await Bun.file(executable).exists()))
          await unlink(executable);
        await rm(directory, { recursive: true, force: true });
      } catch (error) {
        // Diagnose the first failure without retrying deletion or changing process lifetime.
        // Do not print environment, command lines, or fixture file contents.
        console.error("Release cleanup failure", {
          directory,
          target,
          processes,
          error,
          remainingPaths: await readdir(directory, { recursive: true }).catch(String),
        });
        if (process.platform === "win32") {
          try {
            const snapshot = Bun.spawnSync(
              [
                "powershell.exe",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'bun|coforge|MsMpEng' } | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath | ConvertTo-Json -Compress",
              ],
              { stdout: "pipe", stderr: "pipe", timeout: 10_000 },
            );
            console.error("Release cleanup process snapshot (not proof of lock ownership)", {
              exitCode: snapshot.exitCode,
              stdout: snapshot.stdout.toString(),
              stderr: snapshot.stderr.toString(),
            });
          } catch (diagnosticError) {
            console.error("Release cleanup diagnostics unavailable", diagnosticError);
          }
        }
        throw error;
      }
    }
  },
  60_000,
);
test("published unified Computer runs management, Daemon, and Agent modes from one executable", async () => {
  const target = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
  if (!isReleaseTarget(target)) throw new Error(`unsupported test host: ${target}`);
  const directory = await mkdtemp(join(tmpdir(), "coforge-unified-executable-"));
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
