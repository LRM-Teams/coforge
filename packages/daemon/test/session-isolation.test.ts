import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeDriver } from "../src/code-agent/claude-code/driver";
import { CodexDriver } from "../src/code-agent/codex/driver";
import { PiDriver } from "../src/code-agent/pi/driver";

const TEST_AGENT_INSTRUCTIONS = "Test instructions.";

for (const Driver of [ClaudeCodeDriver, CodexDriver]) {
  test(`${Driver.name} rejects an empty resume ID instead of treating it as a fresh session`, async () => {
    const driver = new Driver({ command: ["/not-an-installed-provider"] });
    await expect(
      driver.createAgentSession({
        agentWorkspaceDirectory: tmpdir(),
        instructions: TEST_AGENT_INSTRUCTIONS,
        sessionId: "",
      }),
    ).rejects.toThrow("Invalid session ID");
  });
}

test("embedded Pi resumes an exact persisted session ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-pi-resume-"));
  const workspace = join(root, "agent");
  const sessionFile = join(workspace, ".pi-sessions", "renamed-history.jsonl");
  await mkdir(join(workspace, ".pi-sessions"), { recursive: true });
  await Bun.write(
    sessionFile,
    `${JSON.stringify({ type: "session", version: 3, id: "persisted-exact", cwd: workspace, timestamp: "2026-09-08T00:00:00Z" })}\n`,
  );
  let session: Awaited<ReturnType<PiDriver["createAgentSession"]>> | undefined;
  try {
    session = await new PiDriver().createAgentSession({
      agentWorkspaceDirectory: workspace,
      instructions: TEST_AGENT_INSTRUCTIONS,
      environment: { PI_CODING_AGENT_DIR: join(root, "host") },
      sessionId: "persisted-exact",
    });
    expect(await session.readSessionIdentity!()).toEqual({
      sessionId: "persisted-exact",
      state: "resumable",
    });
  } finally {
    await session?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("embedded Pi replaces a selected ID when its workspace history is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-pi-missing-"));
  const workspace = join(root, "agent");
  await mkdir(workspace);
  const reports: Array<[string, string | undefined]> = [];
  let session: Awaited<ReturnType<PiDriver["createAgentSession"]>> | undefined;
  try {
    session = await new PiDriver().createAgentSession({
      agentWorkspaceDirectory: workspace,
      instructions: TEST_AGENT_INSTRUCTIONS,
      environment: { PI_CODING_AGENT_DIR: join(root, "host") },
      sessionId: "missing-history",
      async onSessionId(id, replaced) {
        reports.push([id, replaced]);
      },
    });
    expect(reports).toHaveLength(1);
    expect(reports[0]?.[0]).not.toBe("missing-history");
    expect(reports[0]?.[1]).toBe("missing-history");
    expect(await session.readSessionIdentity!()).toEqual({
      sessionId: reports[0]![0],
      state: "empty",
    });
  } finally {
    await session?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("embedded Pi rejects empty and path-shaped session IDs", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "coforge-pi-id-"));
  try {
    for (const sessionId of ["", "../other/session", "/global/session.jsonl", "..\\other"]) {
      await expect(
        new PiDriver().createAgentSession({
          agentWorkspaceDirectory: workspace,
          instructions: TEST_AGENT_INSTRUCTIONS,
          environment: { PI_CODING_AGENT_DIR: join(workspace, "host") },
          sessionId,
        }),
      ).rejects.toThrow("Invalid session ID");
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("embedded Pi resolves persisted sessions only inside the owning Agent workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-pi-bounded-"));
  const workspace = join(root, "agent-a");
  const otherWorkspace = join(root, "agent-b");
  await mkdir(workspace);
  await mkdir(join(otherWorkspace, ".pi-sessions"), { recursive: true });
  const reports: string[] = [];
  let fresh: Awaited<ReturnType<PiDriver["createAgentSession"]>> | undefined;
  let resumed: Awaited<ReturnType<PiDriver["createAgentSession"]>> | undefined;
  try {
    fresh = await new PiDriver().createAgentSession({
      agentWorkspaceDirectory: workspace,
      instructions: TEST_AGENT_INSTRUCTIONS,
      environment: { PI_CODING_AGENT_DIR: join(root, "host") },
      async onSessionId(id) {
        reports.push(id);
      },
    });
    expect(reports).toHaveLength(1);
    expect((await fresh.readSessionIdentity!())?.sessionId).toBe(reports[0]);

    const local = join(workspace, ".pi-sessions", "local.jsonl");
    await fresh.dispose();
    fresh = undefined;
    await Bun.write(
      local,
      `${JSON.stringify({ type: "session", version: 3, id: "local", cwd: workspace, timestamp: "2026-09-08T00:00:00Z" })}\n`,
    );
    await Bun.write(
      join(otherWorkspace, ".pi-sessions", "foreign.jsonl"),
      `${JSON.stringify({ type: "session", version: 3, id: "foreign", cwd: otherWorkspace, timestamp: "2026-09-08T00:00:00Z" })}\n`,
    );
    resumed = await new PiDriver().createAgentSession({
      agentWorkspaceDirectory: workspace,
      instructions: TEST_AGENT_INSTRUCTIONS,
      environment: { PI_CODING_AGENT_DIR: join(root, "host") },
      sessionId: "local",
    });
    expect(await resumed.readSessionIdentity!()).toEqual({
      sessionId: "local",
      state: "resumable",
    });
    const foreign = await new PiDriver().createAgentSession({
      agentWorkspaceDirectory: workspace,
      instructions: TEST_AGENT_INSTRUCTIONS,
      environment: { PI_CODING_AGENT_DIR: join(root, "host") },
      sessionId: "foreign",
    });
    try {
      expect(await foreign.readSessionIdentity!()).toBeDefined();
      expect((await foreign.readSessionIdentity!())?.sessionId).not.toBe("foreign");
    } finally {
      await foreign.dispose();
    }
  } finally {
    await fresh?.dispose();
    await resumed?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("embedded Pi refuses a session directory linked outside its Agent workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-pi-session-"));
  const cwd = join(root, "agent-a");
  const other = join(root, "agent-b");
  try {
    await mkdir(cwd);
    await mkdir(other);
    await symlink(other, join(cwd, ".pi-sessions"));
    await expect(
      new PiDriver().createAgentSession({
        agentWorkspaceDirectory: cwd,
        instructions: TEST_AGENT_INSTRUCTIONS,
        environment: { PI_CODING_AGENT_DIR: join(root, "host") },
      }),
    ).rejects.toThrow("Session directory must be directly inside Agent workspace");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
