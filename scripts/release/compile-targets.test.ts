import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
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
      const result = Bun.spawnSync([executable, "--cli-version"], {
        env: { ...Bun.env, COFORGE_COMPUTER_VERSION: "0.0.0-wrong" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe("9.8.7-rc.6\n");
      expect(result.stderr.toString()).toBe("");
      const otherServer = serverUrl.includes("staging")
        ? "https://coforge.cn"
        : "https://staging.coforge.cn";
      const state = join(directory, "daemon-state");
      await mkdir(state);
      await Bun.write(
        join(state, "config.json"),
        JSON.stringify({
          computerId: "test-computer",
          workspaceId: "test-workspace",
          workspaceRoot: directory,
          serverHttpUrl: otherServer,
        }),
      );
      const daemon = Bun.spawn(
        [
          executable,
          "__workspace-daemon",
          "--socket",
          join(directory, "daemon.sock"),
          "--state-directory",
          state,
        ],
        {
          env: {
            ...Bun.env,
            HOME: join(directory, "daemon-home"),
            COFORGE_DAEMON_SERVER_URL: otherServer,
            COFORGE_SERVER_HTTP_URL: otherServer,
          },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 5000,
        },
      );
      const [daemonCode, daemonError] = await Promise.all([
        daemon.exited,
        new Response(daemon.stderr).text(),
      ]);
      expect(daemonCode).toBe(1);
      expect(daemonError).toContain("does not match this daemon build");
      const requests: string[] = [];
      const proxy = Bun.listen({
        hostname: "127.0.0.1",
        port: 0,
        socket: {
          data(socket, data) {
            requests.push(data.toString());
            socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
          },
        },
      });
      try {
        const login = Bun.spawn([executable, "login"], {
          env: {
            ...Bun.env,
            HOME: join(directory, "clean-home"),
            COFORGE_RELEASE_FEED_URL: "https://invalid.example",
            COFORGE_SERVER_HTTP_URL: "https://invalid.example",
            HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`,
            https_proxy: `http://127.0.0.1:${proxy.port}`,
            NO_PROXY: "",
            no_proxy: "",
          },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 5000,
        });
        const [code, stdout, stderr] = await Promise.all([
          login.exited,
          new Response(login.stdout).text(),
          new Response(login.stderr).text(),
        ]);
        expect(code).toBe(1);
        expect(stdout + stderr).toContain(serverUrl);
        // The proxy deliberately rejects the tunnel; this is a routing check, not login success.
        expect(stdout + stderr).toContain("AUTH_FAILED");
        expect(requests.join("\n")).toContain(`CONNECT ${new URL(serverUrl).hostname}:443`);
        expect(requests.join("\n")).not.toContain("invalid.example");
      } finally {
        proxy.stop(true);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
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
