import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeDriver } from "../src/code-agent/claude-code/driver";
import { CodexDriver } from "../src/code-agent/codex/driver";
import { externalPiCommand, PiDriver } from "../src/code-agent/pi/driver";

test("external Pi gets its own session directory without replacing HOME or global skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-pi-session-"));
  const cwd = join(root, "agent");
  const home = join(root, "home");
  await mkdir(cwd);
  const skillPath = join(home, ".pi/agent/skills/proof/SKILL.md");
  await Bun.write(skillPath, "Global skill stays owned by the user.");
  const sessionDir = join(cwd, ".pi-sessions");
  const fixture = new URL("./fixtures/pi-rpc.ts", import.meta.url).pathname;
  try {
    expect(externalPiCommand(sessionDir)).toEqual([
      "pi",
      "--mode",
      "rpc",
      "--session-dir",
      sessionDir,
    ]);
    const session = await new PiDriver({
      command: [process.execPath, fixture, "expected-session-directory"],
    }).createAgentSession({
      agentWorkspaceDirectory: cwd,
      instructions: "Test instructions.",
      environment: { HOME: home, COFORGE_DECLARED_TEST_VALUE: "allowed" },
    });
    await session.dispose();
    expect(await Bun.file(skillPath).text()).toBe("Global skill stays owned by the user.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("external Pi resumes an exact workspace session through its native file argument", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-pi-resume-"));
  const cwd = join(root, "agent");
  const file = join(cwd, ".pi-sessions", "local.jsonl");
  await Bun.write(
    file,
    `${JSON.stringify({ type: "session", version: 3, id: "local-full", cwd, timestamp: "2026-09-08T00:00:00Z" })}\n`,
  );
  const options = {
    agentWorkspaceDirectory: cwd,
    instructions: "Test instructions.",
    environment: { HOME: root, COFORGE_DECLARED_TEST_VALUE: "allowed" },
  };
  const adapter = new PiDriver({
    command: [
      process.execPath,
      new URL("./fixtures/pi-rpc.ts", import.meta.url).pathname,
      "expected-resume-session",
    ],
  });
  try {
    const session = await adapter.createAgentSession({ ...options, sessionId: "local-full" });
    await session.dispose();
    // Exercise the pinned upstream CLI too, not only our protocol fixture.
    const native = await new PiDriver({
      command: [
        process.execPath,
        new URL("../../agent/node_modules/.bin/pi", import.meta.url).pathname,
        "--mode",
        "rpc",
      ],
    }).createAgentSession({
      ...options,
      environment: { ...options.environment, PI_OFFLINE: "1" },
      sessionId: "local-full",
    });
    await native.dispose();
    const missing = await adapter.createAgentSession({ ...options, sessionId: "local" });
    expect(await missing.readSessionIdentity!()).toMatchObject({ state: "empty" });
    await missing.dispose();
    await expect(
      new PiDriver({
        command: [
          process.execPath,
          new URL("./fixtures/pi-rpc.ts", import.meta.url).pathname,
          "expected-resume-session",
          "wrong-resume-session",
        ],
      }).createAgentSession({ ...options, sessionId: "local-full" }),
    ).rejects.toThrow("Pi did not resume the requested workspace session");
    await Bun.write(join(cwd, ".pi-sessions", "duplicate.jsonl"), await Bun.file(file).text());
    await expect(
      adapter.createAgentSession({ ...options, sessionId: "local-full" }),
    ).rejects.toThrow("Ambiguous CoForge session history");
    await Bun.write(
      join(cwd, ".pi-sessions", "foreign.jsonl"),
      `${JSON.stringify({ type: "session", version: 3, id: "foreign", cwd: root, timestamp: "2026-09-08T00:00:00Z" })}\n`,
    );
    const foreignReplacement = await adapter.createAgentSession({
      ...options,
      sessionId: "foreign",
    });
    expect(await foreignReplacement.readSessionIdentity!()).toMatchObject({ state: "empty" });
    await foreignReplacement.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("external Pi reports a fresh native session without using resume", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "coforge-pi-new-session-"));
  const session = await new PiDriver({
    command: [process.execPath, new URL("./fixtures/pi-rpc.ts", import.meta.url).pathname],
  }).createAgentSession({
    agentWorkspaceDirectory: cwd,
    instructions: "Test instructions.",
    environment: { COFORGE_DECLARED_TEST_VALUE: "allowed" },
  });
  try {
    expect(await session.readSessionIdentity?.()).toEqual({
      sessionId: "fixture-new",
      state: "empty",
    });
  } finally {
    await session.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

for (const Driver of [ClaudeCodeDriver, CodexDriver]) {
  test(`${Driver.name} rejects an empty resume ID instead of treating it as a fresh session`, async () => {
    const driver = new Driver({ command: ["/not-an-installed-provider"] });
    await expect(
      driver.createAgentSession({
        agentWorkspaceDirectory: tmpdir(),
        instructions: "Test instructions.",
        sessionId: "",
      }),
    ).rejects.toThrow("Invalid session ID");
  });
}

test("external Pi refuses a session directory linked outside its Agent workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-pi-session-"));
  const cwd = join(root, "agent-a");
  const other = join(root, "agent-b");
  try {
    await mkdir(cwd);
    await mkdir(other);
    await symlink(other, join(cwd, ".pi-sessions"));
    await expect(
      new PiDriver({ command: ["/not-an-installed-provider"] }).createAgentSession({
        agentWorkspaceDirectory: cwd,
        instructions: "Test instructions.",
      }),
    ).rejects.toThrow("Session directory must be directly inside Agent workspace");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
