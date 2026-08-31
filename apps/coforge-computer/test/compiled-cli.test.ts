import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let directory: string;
let executable: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "coforge-computer-cli-"));
  executable = join(directory, "coforge-computer");
  const result = await Bun.build({
    entrypoints: [new URL("../src/cli.ts", import.meta.url).pathname],
    compile: { outfile: executable },
  });
  if (!result.success) throw new AggregateError(result.logs, "failed to compile CLI fixture");
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

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
  expect(result.stdout.toString()).toContain("--server <url>");
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
  expect(result.stdout.toString()).toContain("--server <url>");
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

test("compiled login rejects a server URL containing credentials without printing them", () => {
  const unsafeUrl = "https://user:password@coforge.example";
  const result = Bun.spawnSync({
    cmd: [executable, "login", "--server", unsafeUrl],
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toContain("AUTH_INVALID_SERVER");
  expect(result.stderr.toString()).toContain("Hint:");
  expect(result.stderr.toString()).toContain(
    "server URL must not contain credentials, query, or fragment",
  );
  expect(`${result.stdout}${result.stderr}`).not.toContain(unsafeUrl);
  expect(`${result.stdout}${result.stderr}`).not.toContain("user");
  expect(`${result.stdout}${result.stderr}`).not.toContain("password");
});

test("compiled login strips terminal controls from device authorization instructions", async () => {
  let server: ReturnType<typeof Bun.serve>;
  server = Bun.serve({
    port: 0,
    fetch(request): Response {
      const url = new URL(request.url);
      const issuer = `http://localhost:${server.port}`;
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
      if (url.pathname === "/oauth/token") {
        return Response.json({ error: "access_denied" }, { status: 400 });
      }
      return new Response("not found", { status: 404 });
    },
  });

  try {
    const child = Bun.spawn([executable, "login", "--server", `http://localhost:${server.port}`], {
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const output = `${stdout}${stderr}`;

    expect(exitCode).toBe(1);
    expect(output).toContain("AUTH_DEVICE_CODE_CANCELLED");
    expect(output).not.toContain("\u001b");
    expect(output).toContain(`/activate%1B[31mPWN`);
    expect(output).toContain("User code:   ABCDPWN");
  } finally {
    server.stop(true);
  }
});

test("compiled setup reports a stable network failure without claiming success", () => {
  const result = Bun.spawnSync({
    cmd: [executable, "setup"],
    env: { ...process.env, XDG_CONFIG_HOME: directory },
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toContain("CoForge Computer login");
  expect(result.stderr.toString()).toContain("AUTH_NETWORK_ERROR");
  expect(result.stderr.toString()).toContain("Hint:");
  expect(result.stderr.toString()).not.toContain("registration was created");
});
