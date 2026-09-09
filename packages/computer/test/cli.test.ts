import { expect, test } from "bun:test";

import { runCli, type LoginCommand, type SetupCommand } from "../src/cli";
import { loginError, setupError } from "../src/errors";

test("login uses the server selected by the compiled build", async () => {
  const calls: Array<{ serverUrl: string; json: boolean }> = [];
  const login: LoginCommand = {
    async run(serverUrl, options) {
      calls.push({ serverUrl, json: options.json });
    },
  };

  await expect(
    runCli(["login"], {
      login,
      setup: { async run() {} },
    }),
  ).resolves.toBe(0);
  expect(calls).toEqual([{ serverUrl: "https://coforge.cn", json: false }]);
});

test("login and setup reject the removed public --server option", async () => {
  const dependencies = { login: { async run() {} }, setup: { async run() {} } };
  await expect(runCli(["login", "--server", "https://example.com"], dependencies)).resolves.toBe(1);
  await expect(runCli(["setup", "--server", "https://example.com"], dependencies)).resolves.toBe(1);
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

test("setup with no --workspace and no setup-intent falls back to undefined", async () => {
  const previousIntent = process.env.COFORGE_SETUP_INTENT;
  delete process.env.COFORGE_SETUP_INTENT;
  try {
    const calls: Array<{ workspaceSlug: string | undefined; json: boolean }> = [];
    const setup: SetupCommand = {
      async run(workspaceSlug, options) {
        calls.push({ workspaceSlug, json: options.json });
      },
    };
    const dependencies = { login: { async run() {} }, setup };

    await expect(runCli(["setup"], dependencies)).resolves.toBe(0);

    expect(calls).toEqual([{ workspaceSlug: undefined, json: false }]);
  } finally {
    if (previousIntent === undefined) delete process.env.COFORGE_SETUP_INTENT;
    else process.env.COFORGE_SETUP_INTENT = previousIntent;
  }
});

test("setup forwards an explicit --workspace slug", async () => {
  const calls: Array<{ workspaceSlug: string | undefined }> = [];
  const setup: SetupCommand = {
    async run(workspaceSlug) {
      calls.push({ workspaceSlug });
    },
  };
  const dependencies = { login: { async run() {} }, setup };

  await expect(runCli(["setup", "--workspace", "acme-inc"], dependencies)).resolves.toBe(0);

  expect(calls).toEqual([{ workspaceSlug: "acme-inc" }]);
});

test("setup falls back to COFORGE_SETUP_INTENT when --workspace is omitted", async () => {
  const previousIntent = process.env.COFORGE_SETUP_INTENT;
  process.env.COFORGE_SETUP_INTENT = JSON.stringify({ workspaceSlug: "intent-workspace" });
  try {
    const calls: Array<{ workspaceSlug: string | undefined }> = [];
    const setup: SetupCommand = {
      async run(workspaceSlug) {
        calls.push({ workspaceSlug });
      },
    };
    const dependencies = { login: { async run() {} }, setup };

    await expect(runCli(["setup"], dependencies)).resolves.toBe(0);

    expect(calls).toEqual([{ workspaceSlug: "intent-workspace" }]);
  } finally {
    if (previousIntent === undefined) delete process.env.COFORGE_SETUP_INTENT;
    else process.env.COFORGE_SETUP_INTENT = previousIntent;
  }
});

test("--workspace takes priority over COFORGE_SETUP_INTENT", async () => {
  const previousIntent = process.env.COFORGE_SETUP_INTENT;
  process.env.COFORGE_SETUP_INTENT = JSON.stringify({ workspaceSlug: "intent-workspace" });
  try {
    const calls: Array<{ workspaceSlug: string | undefined }> = [];
    const setup: SetupCommand = {
      async run(workspaceSlug) {
        calls.push({ workspaceSlug });
      },
    };
    const dependencies = { login: { async run() {} }, setup };

    await expect(runCli(["setup", "--workspace", "cli-workspace"], dependencies)).resolves.toBe(0);

    expect(calls).toEqual([{ workspaceSlug: "cli-workspace" }]);
  } finally {
    if (previousIntent === undefined) delete process.env.COFORGE_SETUP_INTENT;
    else process.env.COFORGE_SETUP_INTENT = previousIntent;
  }
});

test("an invalid --workspace slug fails locally without reaching the setup command", async () => {
  const stderr: string[] = [];
  const setup: SetupCommand = {
    async run() {
      throw new Error("must not be called for an invalid slug");
    },
  };
  const dependencies = { login: { async run() {} }, setup };

  const exitCode = await runCli(["setup", "--workspace", "Not Valid!"], dependencies, {
    stdout: () => undefined,
    stderr: (line) => stderr.push(line),
  });

  expect(exitCode).toBe(1);
  expect(stderr.join("\n")).toContain("SETUP_WORKSPACE_INVALID");
  expect(stderr.join("\n")).toContain("Hint:");
});

test("an empty --workspace value is rejected rather than falling back to the setup intent", async () => {
  const previousIntent = process.env.COFORGE_SETUP_INTENT;
  process.env.COFORGE_SETUP_INTENT = JSON.stringify({ workspaceSlug: "intent-workspace" });
  try {
    const setup: SetupCommand = {
      async run() {
        throw new Error("must not be called for an empty slug");
      },
    };
    const dependencies = { login: { async run() {} }, setup };
    const stderr: string[] = [];

    const exitCode = await runCli(["setup", "--workspace", ""], dependencies, {
      stdout: () => undefined,
      stderr: (line) => stderr.push(line),
    });

    expect(exitCode).toBe(1);
    expect(stderr.join("\n")).toContain("SETUP_WORKSPACE_INVALID");
  } finally {
    if (previousIntent === undefined) delete process.env.COFORGE_SETUP_INTENT;
    else process.env.COFORGE_SETUP_INTENT = previousIntent;
  }
});

test("JSON setup with neither --workspace nor COFORGE_SETUP_INTENT reports an actionable hint", async () => {
  const previousIntent = process.env.COFORGE_SETUP_INTENT;
  delete process.env.COFORGE_SETUP_INTENT;
  try {
    const stdout: string[] = [];
    const dependencies = {
      login: { async run() {} },
      setup: {
        async run() {
          throw setupError(
            "SETUP_WORKSPACE_REQUIRED",
            "Setup requires a target Workspace: pass `--workspace <slug>`, or set COFORGE_SETUP_INTENT for automated setup.",
          );
        },
      },
    };

    const exitCode = await runCli(["setup", "--json"], dependencies, {
      stdout: (line) => stdout.push(line),
      stderr: () => undefined,
    });

    expect(exitCode).toBe(1);
    const output = JSON.parse(stdout[0]!);
    expect(output.error.code).toBe("SETUP_WORKSPACE_REQUIRED");
    expect(output.error.hint).toContain("--workspace <slug>");
  } finally {
    if (previousIntent === undefined) delete process.env.COFORGE_SETUP_INTENT;
    else process.env.COFORGE_SETUP_INTENT = previousIntent;
  }
});

test("JSON setup failure is one stable stdout object with an actionable hint", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli(
    ["setup", "--json"],
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
    ["setup"],
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

test.each(["", "n", "no", "maybe", null])(
  "upgrade cancels without explicit consent: %s",
  async (answer) => {
    let upgrades = 0;
    const output: string[] = [];
    const questions: string[] = [];
    const exitCode = await runCli(
      ["upgrade"],
      {
        login: { async run() {} },
        setup: { async run() {} },
        updater: {
          async resolveVersion() {
            return "1.0.18";
          },
          async install() {},
          async upgrade() {
            upgrades += 1;
          },
          async rollback() {},
        },
      },
      {
        stdout: (line) => output.push(line),
        stderr: (line) => output.push(line),
        prompt: (question) => {
          questions.push(question);
          return answer;
        },
      },
    );
    expect(exitCode).toBe(0);
    expect(upgrades).toBe(0);
    expect(questions).toEqual(["Upgrade CoForge Computer to 1.0.18? [y/N] "]);
    expect(output).toEqual(["Upgrade cancelled."]);
  },
);

test.each(["y", " YES "])(
  "install and rollback remain unchanged; upgrade requires consent: %s",
  async (answer) => {
    const calls: Array<{ operation: string; version?: string }> = [];
    const dependencies = {
      login: { async run() {} },
      setup: { async run() {} },
      updater: {
        async resolveVersion(selector: string) {
          expect(selector).toBe("latest");
          return "1.0.18";
        },
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
    const questions: string[] = [];
    await expect(
      runCli(["upgrade"], dependencies, {
        stdout: () => {},
        stderr: () => {},
        prompt: (question) => {
          questions.push(question);
          return answer;
        },
      }),
    ).resolves.toBe(0);
    expect(questions).toEqual(["Upgrade CoForge Computer to 1.0.18? [y/N] "]);
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
      { operation: "upgrade", version: "1.0.18" },
      {
        operation: "install",
        version: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      },
      { operation: "rollback" },
    ]);
  },
);

test("foreground runs the supervisor in the current process for external supervision", async () => {
  let calls = 0;
  const exitCode = await runCli(["foreground"], {
    login: { async run() {} },
    setup: { async run() {} },
    foreground: {
      async run() {
        calls += 1;
      },
    },
  });

  expect(exitCode).toBe(0);
  expect(calls).toBe(1);
});
