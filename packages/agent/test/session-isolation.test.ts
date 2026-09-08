import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, resolveAgentSessionFile } from "../src/runner";

test("session storage cannot escape through a supplied directory or symbolic link", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-session-"));
  const cwd = join(root, "agent");
  const global = join(root, "home-sessions");
  await mkdir(cwd);
  await mkdir(global);
  const options = { cwd, apiKey: "fixture-key", instructions: "Test instructions." };
  try {
    let created: Awaited<ReturnType<typeof createSession>> | undefined;
    try {
      await expect(
        createSession({ ...options, sessionDir: join(cwd, ".other-sessions") }).then((value) => {
          created = value;
          return value;
        }),
      ).rejects.toThrow("CoForge sessions must use .builtin-sessions");
    } finally {
      await created?.dispose();
    }
    await expect(createSession({ ...options, sessionDir: global })).rejects.toThrow(
      "CoForge sessions must use .builtin-sessions",
    );
    await symlink(global, join(cwd, ".builtin-sessions"));
    await expect(createSession(options)).rejects.toThrow(
      "Session directory must be directly inside Agent workspace",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session IDs are exact identities, not file paths or prefixes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "coforge-session-"));
  const options = { cwd, apiKey: "fixture-key", instructions: "Test instructions." };
  try {
    for (const sessionId of ["", "../other/session", "/global/session.jsonl", "..\\other"]) {
      let created: Awaited<ReturnType<typeof createSession>> | undefined;
      try {
        await expect(
          createSession({ ...options, sessionId }).then((value) => {
            created = value;
            return value;
          }),
        ).rejects.toThrow("Invalid session ID");
      } finally {
        await created?.dispose();
      }
    }
    await Bun.write(
      join(cwd, ".builtin-sessions", "local.jsonl"),
      `${JSON.stringify({ type: "session", version: 3, id: "local-full", cwd, timestamp: "2026-09-08T00:00:00Z" })}\n`,
    );
    await expect(
      resolveAgentSessionFile(cwd, join(cwd, ".builtin-sessions"), "local"),
    ).rejects.toThrow("Session not found in Agent workspace");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("fresh and resumed sessions use only the owning Agent workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-session-"));
  const cwd = join(root, "agent-a");
  await mkdir(cwd);
  const options = { cwd, apiKey: "fixture-key", instructions: "Test instructions." };
  try {
    const fresh = await createSession(options);
    try {
      expect(fresh.session.sessionFile?.startsWith(join(cwd, ".builtin-sessions") + "/")).toBe(
        true,
      );
    } finally {
      await fresh.dispose();
    }
    const local = join(cwd, ".builtin-sessions", "local.jsonl");
    await Bun.write(
      local,
      `${JSON.stringify({ type: "session", version: 3, id: "local", cwd, timestamp: "2026-09-08T00:00:00Z" })}\n`,
    );
    const resumed = await createSession({ ...options, sessionId: "local" });
    try {
      expect(resumed.session.sessionId).toBe("local");
      expect(resumed.session.sessionFile).toBe(local);
    } finally {
      await resumed.dispose();
    }
    const foreign = join(root, "agent-b", ".builtin-sessions", "foreign.jsonl");
    await Bun.write(
      foreign,
      `${JSON.stringify({ type: "session", version: 3, id: "foreign", cwd: join(root, "agent-b"), timestamp: "2026-09-08T00:00:00Z" })}\n`,
    );
    await expect(
      resolveAgentSessionFile(cwd, join(cwd, ".builtin-sessions"), "foreign"),
    ).rejects.toThrow("Session not found in Agent workspace");
    await symlink(foreign, join(cwd, ".builtin-sessions", "foreign.jsonl"));
    await expect(createSession({ ...options, sessionId: "foreign" })).rejects.toThrow(
      "Session files must not be symbolic links",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the strict resolver rejects a requested session absent from this Agent workspace", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "coforge-session-"));
  try {
    await expect(
      resolveAgentSessionFile(cwd, join(cwd, ".builtin-sessions"), "another-agent-session"),
    ).rejects.toThrow("Session not found in Agent workspace");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
