import { afterEach, expect, spyOn, test } from "bun:test";
import { chmod, mkdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import {
  AgentMessageDraftStore,
  AGENT_MESSAGE_DRAFT_TTL_MS,
} from "../src/persistence/agent-message-draft-store";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("saves and loads only a versioned Agent message draft", async () => {
  const stateDirectory = temporaryStateDirectory();
  const store = new AgentMessageDraftStore("agent/a", stateDirectory, () => 1_000);

  await store.save("@ada", "draft reply", "opaque-hold-token");

  expect(await store.load("@ada")).toEqual({
    target: "@ada",
    body: "draft reply",
    holdToken: "opaque-hold-token",
    savedAt: 1_000,
  });
  expect(
    JSON.parse(
      await readFile(
        join(
          stateDirectory,
          `coforge-cli-attested-send-${process.geteuid?.() ?? encodeURIComponent(userInfo().username).replaceAll(".", "%2E")}`,
          "agent%2Fa",
          "continue-state.json",
        ),
        "utf8",
      ),
    ),
  ).toEqual({
    version: 1,
    drafts: [
      { target: "@ada", body: "draft reply", holdToken: "opaque-hold-token", savedAt: 1_000 },
    ],
  });
});

test("expires drafts after Raft's ten-minute local draft TTL", async () => {
  const stateDirectory = temporaryStateDirectory();
  let now = 1_000;
  const store = new AgentMessageDraftStore("agent-a", stateDirectory, () => now);
  await store.save("@ada", "draft reply", "opaque-hold-token");

  now += AGENT_MESSAGE_DRAFT_TTL_MS + 1;

  expect(await store.load("@ada")).toBeUndefined();
});

test("replacing a draft body removes its old hold token", async () => {
  const stateDirectory = temporaryStateDirectory();
  const store = new AgentMessageDraftStore("agent-a", stateDirectory, () => 1_000);
  await store.save("@ada", "first reply", "old-token");

  await store.save("@ada", "changed reply");

  expect(await store.load("@ada")).toEqual({
    target: "@ada",
    body: "changed reply",
    savedAt: 1_000,
  });
});

function temporaryStateDirectory() {
  const path = join(tmpdir(), `coforge-agent-drafts-${crypto.randomUUID()}`);
  directories.push(path);
  return path;
}

// Effective UID is an OS boundary; both users share the same temporary root.
test.skipIf(!process.geteuid)("isolates drafts belonging to different system users", async () => {
  const stateDirectory = temporaryStateDirectory();
  const uid = process.geteuid!();
  const identity = spyOn(process, "geteuid");
  try {
    identity.mockReturnValue(1001);
    const first = new AgentMessageDraftStore("shared-agent", stateDirectory);
    identity.mockReturnValue(uid);
    await first.save("@ada", "first user's reply");
    identity.mockReturnValue(1009);
    const second = new AgentMessageDraftStore("shared-agent", stateDirectory);
    identity.mockReturnValue(uid);
    expect(await second.load("@ada")).toBeUndefined();
    await second.save("@ada", "second user's reply");
    expect((await first.load("@ada"))?.body).toBe("first user's reply");
    expect((await second.load("@ada"))?.body).toBe("second user's reply");
    await second.clear("@ada");
    expect((await first.load("@ada"))?.body).toBe("first user's reply");
  } finally {
    identity.mockRestore();
  }
});

function userDirectory(root: string) {
  return join(
    root,
    `coforge-cli-attested-send-${process.geteuid?.() ?? encodeURIComponent(userInfo().username).replaceAll(".", "%2E")}`,
  );
}

test("rejects a linked user draft directory before touching its target", async () => {
  const root = temporaryStateDirectory();
  const outside = temporaryStateDirectory();
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await symlink(outside, userDirectory(root), process.platform === "win32" ? "junction" : "dir");
  const store = new AgentMessageDraftStore("agent-a", root);
  await expect(store.save("@ada", "private reply")).rejects.toThrow("draft directory");
  expect(await Bun.file(join(outside, "agent-a", "continue-state.json")).exists()).toBe(false);
});

test.skipIf(!process.geteuid)(
  "rejects a draft directory owned by another user without changing its mode",
  async () => {
    const root = temporaryStateDirectory();
    const directory = userDirectory(root);
    await mkdir(directory, { recursive: true, mode: 0o755 });
    await chmod(directory, 0o755);
    const store = new AgentMessageDraftStore("agent-a", root);
    const uid = process.geteuid!();
    const identity = spyOn(process, "geteuid").mockReturnValue(uid + 1);
    try {
      await expect(store.save("@ada", "private reply")).rejects.toThrow(
        "owned by the current user",
      );
      expect((await stat(directory)).mode & 0o777).toBe(0o755);
    } finally {
      identity.mockRestore();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "makes existing user and Agent draft directories private",
  async () => {
    const root = temporaryStateDirectory();
    const user = userDirectory(root);
    const agent = join(user, "agent-a");
    await mkdir(agent, { recursive: true });
    await chmod(user, 0o755);
    await chmod(agent, 0o755);
    const store = new AgentMessageDraftStore("agent-a", root);
    await store.save("@ada", "private reply");
    expect((await stat(user)).mode & 0o777).toBe(0o700);
    expect((await stat(agent)).mode & 0o777).toBe(0o700);
    expect((await stat(join(agent, "continue-state.json"))).mode & 0o777).toBe(0o600);
    await store.clear("@ada");
    expect(await store.load("@ada")).toBeUndefined();
  },
);

test("rejects a linked Agent directory for reads and cleanup", async () => {
  const root = temporaryStateDirectory();
  const outside = temporaryStateDirectory();
  await mkdir(userDirectory(root), { recursive: true });
  await mkdir(outside, { recursive: true });
  await Bun.write(join(outside, "continue-state.json"), JSON.stringify({ version: 1, drafts: [] }));
  await symlink(
    outside,
    join(userDirectory(root), "agent-a"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const store = new AgentMessageDraftStore("agent-a", root);
  await expect(store.load("@ada")).rejects.toThrow("draft directory");
  await expect(store.clear("@ada")).rejects.toThrow("draft directory");
  expect(await Bun.file(join(outside, "continue-state.json")).exists()).toBe(true);
});
