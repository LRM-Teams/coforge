import { expect, test } from "bun:test";

import { runCli, type LoginCommand, type SetupCommand } from "../src/cli";
import { loginError, setupError } from "../src/errors";

test("login starts device authorization for the selected server", async () => {
  const calls: Array<{ serverUrl: string; json: boolean }> = [];
  const login: LoginCommand = {
    async run(serverUrl, options) {
      calls.push({ serverUrl, json: options.json });
    },
  };

  await expect(
    runCli(["login", "--server", "https://coforge.example"], {
      login,
      setup: { async run() {} },
    }),
  ).resolves.toBe(0);
  expect(calls).toEqual([{ serverUrl: "https://coforge.example", json: false }]);
});

test("login forwards JSON mode to the command", async () => {
  const calls: boolean[] = [];
  const exitCode = await runCli(["login", "--json"], {
    login: {
      async run(_serverUrl, options) {
        calls.push(options.json);
      },
    },
    setup: { async run() {} },
  });

  expect(exitCode).toBe(0);
  expect(calls).toEqual([true]);
});

test("JSON login failure is one stable stdout object with an actionable hint", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli(
    ["login", "--json"],
    {
      login: {
        async run() {
          throw loginError("AUTH_DEVICE_CODE_EXPIRED", "The device authorization code expired.");
        },
      },
      setup: { async run() {} },
    },
    { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
  );

  expect(exitCode).toBe(1);
  expect(stderr).toEqual([]);
  expect(stdout).toHaveLength(1);
  expect(JSON.parse(stdout[0]!)).toEqual({
    ok: false,
    error: {
      code: "AUTH_DEVICE_CODE_EXPIRED",
      message: "The device authorization code expired.",
      hint: "Run `coforge-computer login` again to request a new code.",
    },
  });
});

for (const code of [
  "AUTH_DEVICE_CODE_EXPIRED",
  "AUTH_DEVICE_CODE_CANCELLED",
  "AUTH_NETWORK_ERROR",
] as const) {
  test(`${code} has stable human and JSON failures`, async () => {
    for (const json of [false, true]) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const exitCode = await runCli(
        ["login", ...(json ? ["--json"] : [])],
        {
          login: {
            async run() {
              throw loginError(code, "Login could not continue.");
            },
          },
          setup: { async run() {} },
        },
        { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
      );

      expect(exitCode).toBe(1);
      const output = json ? JSON.parse(stdout[0]!) : stderr.join("\n");
      if (json) {
        expect(stdout).toHaveLength(1);
        expect(output.error.code).toBe(code);
        expect(output.error.hint.length).toBeGreaterThan(0);
      } else {
        expect(stdout).toEqual([]);
        expect(output).toContain(code);
        expect(output).toContain("Hint:");
      }
    }
  });
}

test("unexpected login failures are normalized without exposing diagnostics", async () => {
  const stderr: string[] = [];
  const exitCode = await runCli(
    ["login"],
    {
      login: {
        async run() {
          throw new Error("token=access-secret");
        },
      },
      setup: { async run() {} },
    },
    { stdout: () => undefined, stderr: (line) => stderr.push(line) },
  );

  expect(exitCode).toBe(1);
  expect(stderr.join("\n")).toContain("AUTH_FAILED");
  expect(stderr.join("\n")).toContain("Hint:");
  expect(stderr.join("\n")).not.toContain("access-secret");
});

test("setup accepts the Workspace slug through an explicit option", async () => {
  const calls: Array<{ workspaceSlug: string | undefined; json: boolean }> = [];
  const setup: SetupCommand = {
    async run(workspaceSlug, options) {
      calls.push({ workspaceSlug, json: options.json });
    },
  };
  const dependencies = { login: { async run() {} }, setup };

  await expect(runCli(["setup", "--workspace", "workspace-a"], dependencies)).resolves.toBe(0);

  expect(calls).toEqual([{ workspaceSlug: "workspace-a", json: false }]);
});

test("setup forwards an explicit server URL", async () => {
  let serverUrl: string | undefined;
  await expect(
    runCli(["setup", "--server", "https://coforge.example", "--workspace", "workspace-a"], {
      login: { async run() {} },
      setup: {
        async run(_workspace, options) {
          serverUrl = options.serverUrl;
        },
      },
    }),
  ).resolves.toBe(0);
  expect(serverUrl).toBe("https://coforge.example");
});

test("JSON setup failure is one stable stdout object with an actionable hint", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli(
    ["setup", "--workspace", "missing", "--json"],
    {
      login: { async run() {} },
      setup: {
        async run() {
          throw setupError("SETUP_WORKSPACE_NOT_FOUND", "Workspace slug is not accessible.");
        },
      },
    },
    { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
  );

  expect(exitCode).toBe(1);
  expect(stderr).toEqual([]);
  expect(stdout).toHaveLength(1);
  expect(JSON.parse(stdout[0]!)).toEqual({
    ok: false,
    error: {
      code: "SETUP_WORKSPACE_NOT_FOUND",
      message: "Workspace slug is not accessible.",
      hint: "Check the Workspace slug and your account access, then rerun setup.",
    },
  });
});

test("unexpected setup failures are normalized without exposing diagnostics", async () => {
  const stderr: string[] = [];
  const exitCode = await runCli(
    ["setup", "--workspace", "workspace-a"],
    {
      login: { async run() {} },
      setup: {
        async run() {
          throw new Error("token=access-secret");
        },
      },
    },
    { stdout: () => undefined, stderr: (line) => stderr.push(line) },
  );

  expect(exitCode).toBe(1);
  expect(stderr.join("\n")).toContain("SETUP_FAILED");
  expect(stderr.join("\n")).toContain("Hint:");
  expect(stderr.join("\n")).not.toContain("access-secret");
});

test("install and upgrade preserve the three release-set selection modes", async () => {
  const calls: Array<{ operation: string; version?: string }> = [];
  const dependencies = {
    login: { async run() {} },
    setup: { async run() {} },
    updater: {
      async install(version: string) {
        calls.push({ operation: "install", version });
      },
      async upgrade(version: string) {
        calls.push({ operation: "upgrade", version });
      },
      async rollback() {
        calls.push({ operation: "rollback" });
      },
    },
  };

  await expect(runCli(["install"], dependencies)).resolves.toBe(0);
  await expect(runCli(["upgrade", "--version", "test"], dependencies)).resolves.toBe(0);
  await expect(
    runCli(
      [
        "install",
        "--version",
        "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      ],
      dependencies,
    ),
  ).resolves.toBe(0);
  await expect(runCli(["rollback"], dependencies)).resolves.toBe(0);

  expect(calls).toEqual([
    { operation: "install", version: "latest" },
    { operation: "upgrade", version: "test" },
    {
      operation: "install",
      version: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
    { operation: "rollback" },
  ]);
});
