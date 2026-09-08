import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ComputerUpdater } from "../src/updater";
import { buildReleaseTree } from "../../../scripts/release/build-release";

let directory: string;
let executable: string;
let daemonExecutable: string;

test("release-only installation provides the Agent CLI without a separate executable", async () => {
  const feed = join(directory, "feed");
  const version = "9.0.0-test";
  const target = "linux-x64";
  await buildReleaseTree(
    {
      version,
      commit: "a".repeat(40),
      buildDate: "2026-09-05T00:00:00Z",
      artifacts: {
        [target]: {
          computer: new Uint8Array(await Bun.file(executable).arrayBuffer()),
          daemon: new Uint8Array(await Bun.file(daemonExecutable).arrayBuffer()),
        },
      },
    },
    feed,
  );
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(path);
      if (path === "/agent/message") {
        const body = await request.json();
        return Response.json({ operation: body.operation, body: body.body, messages: [] });
      }
      return new Response(Bun.file(join(feed, path)));
    },
  });
  try {
    const root = join(directory, "installed with spaces");
    await new ComputerUpdater({
      baseUrl: server.url.toString(),
      target,
      installRoot: root,
    }).install(version);
    const bin = join(root, "versions", version);
    await rm(join(bin, "coforge-computer"));
    const invoke = async (args: string[], input = "") => {
      const child = Bun.spawn([join(bin, "coforge"), ...args], {
        cwd: directory,
        env: {
          HOME: join(directory, "agent-home"),
          PATH: bin,
          COFORGE_AGENT_CONTEXT: `sfp_${"a".repeat(43)}`,
          COFORGE_AGENT_PROXY_URL: `${server.url}agent/message`,
        },
        stdin: new Blob([input]),
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      });
      return {
        code: await child.exited,
        stdout: await new Response(child.stdout).text(),
        stderr: await new Response(child.stderr).text(),
      };
    };
    expect(await invoke(["message", "check"])).toEqual({
      code: 0,
      stdout: "No new inbox messages.\n",
      stderr: "",
    });
    const sent = await invoke(["message", "send", "--target", "@user"], "release-only hello");
    expect(sent.code).toBe(0);
    expect(sent.stdout).toContain("release-only hello");
    expect((await invoke(["setup"])).code).toBe(1);
    expect(
      await Bun.file(join(directory, "agent-home", ".coforge", "computer", "config.json")).exists(),
    ).toBe(false);
    expect(requests).toContain(`/${version}/${target}/coforge-computer.gz`);
    expect(requests).toContain(`/${version}/${target}/coforge-daemon.gz`);
    expect(requests).not.toContain(`/${version}/${target}/coforge-computer`);
  } finally {
    server.stop(true);
  }
}, 30_000);

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "coforge-computer-cli-"));
  executable = join(directory, "coforge-computer");
  const result = await Bun.build({
    entrypoints: [new URL("../src/cli.ts", import.meta.url).pathname],
    compile: { outfile: executable },
  });
  if (!result.success) throw new AggregateError(result.logs, "failed to compile CLI fixture");
  daemonExecutable = join(directory, "coforge-daemon");
  const daemon = await Bun.build({
    entrypoints: [new URL("../../daemon/index.ts", import.meta.url).pathname],
    compile: { outfile: daemonExecutable },
  });
  if (!daemon.success) throw new AggregateError(daemon.logs, "failed to compile Daemon fixture");
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

test("local test build strips terminal controls from device authorization instructions", async () => {
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push(url.pathname);
      const issuer = url.origin;
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer,
          device_authorization_endpoint: `${issuer}/oauth/device`,
          token_endpoint: `${issuer}/oauth/token`,
        });
      }
      if (url.pathname === "/oauth/device") {
        return Response.json({
          device_code: "device-secret",
          user_code: "ABCD\u001b[31mPWN",
          verification_uri: `${issuer}/activate\u001b[31mPWN`,
          expires_in: 5,
          interval: 1,
        });
      }
      return Response.json({ error: "access_denied" }, { status: 400 });
    },
  });
  try {
    const fixture = join(directory, "local-computer");
    const built = await Bun.build({
      entrypoints: [new URL("../src/cli.ts", import.meta.url).pathname],
      compile: { outfile: fixture },
      plugins: [
        {
          name: "local-test-server",
          setup(build) {
            build.onLoad({ filter: /\/computer\/src\/release-channel\.ts$/ }, () => ({
              contents: `export const COFORGE_SERVER_URL = ${JSON.stringify(server.url.origin)}; export const COFORGE_RELEASE_FEED_URL = "https://releases.coforge.cn";`,
              loader: "ts",
            }));
          },
        },
      ],
    });
    expect(built.success).toBe(true);
    const child = Bun.spawn([fixture, "login", "--json"], {
      env: { ...process.env, HOME: join(directory, "local-home"), FORCE_COLOR: "0", NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(1);
    expect(stdout + stderr).toContain("AUTH_DEVICE_CODE_CANCELLED");
    expect(stdout + stderr).not.toContain("\u001b");
    expect(stdout + stderr).toContain("/activate%1B[31mPWN");
    expect(stdout + stderr).toContain("User code:   ABCDPWN");
    expect(requests).toEqual([
      "/.well-known/oauth-authorization-server",
      "/oauth/device",
      "/oauth/token",
    ]);
  } finally {
    server.stop(true);
  }
}, 15_000);

test("compiled CLI writes help to stdout and exits successfully", () => {
  const result = Bun.spawnSync({ cmd: [executable, "--help"], stdout: "pipe", stderr: "pipe" });

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("login [options]");
  expect(result.stdout.toString()).toContain("setup [options]");
  expect(result.stdout.toString()).toContain("install [options]");
  expect(result.stdout.toString()).toContain("upgrade [options]");
  expect(result.stdout.toString()).toContain("rollback");
  expect(result.stdout.toString()).toContain("start");
  expect(result.stdout.toString()).toContain("stop");
  expect(result.stdout.toString()).toContain("restart");
  expect(result.stdout.toString()).toContain("logs");
  expect(result.stderr.toString()).toBe("");
});

test("compiled login help documents the stable automation options", () => {
  const result = Bun.spawnSync({
    cmd: [executable, "login", "--help"],
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("Usage: coforge-computer login [options]");
  expect(result.stdout.toString()).toContain("Sign in to CoForge without selecting a Workspace.");
  expect(result.stdout.toString()).not.toContain("register");
  expect(result.stdout.toString()).not.toContain("--server");
  expect(result.stdout.toString()).toContain("--json");
  expect(result.stderr.toString()).toBe("");
});

test("compiled setup help documents JSON mode and does not offer --all", () => {
  const result = Bun.spawnSync({
    cmd: [executable, "setup", "--help"],
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("--json");
  expect(result.stdout.toString()).not.toContain("--server");
  expect(result.stdout.toString()).not.toContain("--all");
  expect(result.stderr.toString()).toBe("");
});

test("compiled CLI writes usage errors to stderr with a stable nonzero exit code", () => {
  const result = Bun.spawnSync({
    cmd: [executable, "setup", "workspace-a", "--all"],
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toContain("unknown option '--all'");
  expect(result.stderr.toString()).not.toContain("Error:");
});

test("compiled login rejects the removed server override without printing its value", () => {
  const unsafeUrl = "https://user:password@coforge.example";
  const result = Bun.spawnSync({
    cmd: [executable, "login", "--server", unsafeUrl],
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toContain("unknown option '--server'");
  expect(`${result.stdout}${result.stderr}`).not.toContain(unsafeUrl);
  expect(`${result.stdout}${result.stderr}`).not.toContain("user");
  expect(`${result.stdout}${result.stderr}`).not.toContain("password");
});

test("compiled setup rejects the removed server override without claiming success", () => {
  const result = Bun.spawnSync({
    cmd: [executable, "setup", "--server", "https://127.0.0.1:1"],
    env: { ...process.env, XDG_CONFIG_HOME: directory },
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("unknown option '--server'");
  expect(`${result.stdout}${result.stderr}`).not.toContain("registration was created");
});

test("compiled environment mismatch blocks login, setup, start, and restart", async () => {
  const home = join(directory, "cross-environment-home");
  const configDirectory = join(home, ".coforge", "computer");
  await mkdir(configDirectory, { recursive: true });
  await writeFile(
    join(configDirectory, "profile.json"),
    JSON.stringify({ server_url: "https://staging.coforge.cn" }),
  );

  for (const command of ["login", "setup", "start", "restart"]) {
    const result = Bun.spawnSync({
      cmd: [executable, command],
      env: { ...process.env, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("BUILD_ENVIRONMENT_MISMATCH");
  }
  expect(await Bun.file(join(home, ".coforge", "daemon", "daemon.json")).exists()).toBe(false);
});

test("compiled JSON setup also rejects the removed server override", () => {
  const result = Bun.spawnSync({
    cmd: [executable, "setup", "--server", "https://127.0.0.1:1", "--json"],
    env: { ...process.env, XDG_CONFIG_HOME: directory },
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toBe("");
  expect(result.stdout.toString()).not.toContain("CoForge Computer login");
  expect(result.stderr.toString()).toContain("unknown option '--server'");
  expect(`${result.stdout}${result.stderr}`).not.toContain("registration was created");
});
