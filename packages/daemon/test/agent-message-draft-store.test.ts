import { afterEach, expect, spyOn, test } from "bun:test";
import { chmod, mkdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import {
  AgentMessageDraftStore,
  AGENT_MESSAGE_DRAFT_TTL_MS,
} from "#src/persistence/agent-message-draft-store";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

/** The draft `lookup` found, or `undefined` for any other status. */
async function found(store: AgentMessageDraftStore, target: string) {
  const lookup = await store.lookup(target);
  return lookup.status === "found" ? lookup.draft : undefined;
}

test("saves and looks up one Agent message draft in Raft's continue-state shape", async () => {
  const stateDirectory = temporaryStateDirectory();
  const store = new AgentMessageDraftStore("agent/a", stateDirectory, () => 1_000);

  await store.save("@ada", { content: "draft reply", idempotencyKey: "key-1" });

  expect(await store.lookup("@ada")).toEqual({
    status: "found",
    draft: {
      target: "@ada",
      content: "draft reply",
      idempotencyKey: "key-1",
      reholdCount: 0,
      savedAt: 1_000,
    },
  });
  // Raft's file: a `targets` map keyed by target, the text as `content`, and the same field names
  // (`attachmentIds`, `idempotencyKey`, `mentions`, `savedAt`, `reholdCount`, `seenUpToSeq`).
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
    targets: {
      "@ada": {
        content: "draft reply",
        attachmentIds: [],
        idempotencyKey: "key-1",
        savedAt: 1_000,
        reholdCount: 0,
      },
    },
  });
});

test("keeps each target's draft under its own key and clears one without the other", async () => {
  const stateDirectory = temporaryStateDirectory();
  const store = new AgentMessageDraftStore("agent-a", stateDirectory, () => 1_000);
  await store.save("@ada", { content: "to ada", idempotencyKey: "key-ada" });
  await store.save("#general", { content: "to the channel", idempotencyKey: "key-general" });

  expect((await found(store, "@ada"))?.content).toBe("to ada");
  expect((await found(store, "#general"))?.content).toBe("to the channel");

  await store.clear("@ada");
  expect(await store.lookup("@ada")).toEqual({ status: "missing" });
  expect((await found(store, "#general"))?.content).toBe("to the channel");
});

test("saves and looks up a held draft's attachmentIds, mentions and seenUpToSeq", async () => {
  const stateDirectory = temporaryStateDirectory();
  const store = new AgentMessageDraftStore("agent-a", stateDirectory, () => 1_000);
  const mentions = [{ type: "user" as const, id: "actor-1", name: "ada" }];

  await store.replace("@ada", {
    content: "draft reply",
    idempotencyKey: "key-1",
    reholdCount: 1,
    attachmentIds: ["attachment-1", "attachment-2"],
    mentions,
    seenUpToSeq: 9,
  });

  expect(await found(store, "@ada")).toEqual({
    target: "@ada",
    content: "draft reply",
    idempotencyKey: "key-1",
    reholdCount: 1,
    attachmentIds: ["attachment-1", "attachment-2"],
    mentions,
    seenUpToSeq: 9,
    savedAt: 1_000,
  });
});

test("reads a draft file Raft itself wrote, including its key and seenUpToSeq", async () => {
  const stateDirectory = temporaryStateDirectory();
  const store = new AgentMessageDraftStore("agent-a", stateDirectory, () => 1_000);
  await writeDraftFile(stateDirectory, {
    targets: {
      "@ada": {
        content: "raft reply",
        attachmentIds: [],
        idempotencyKey: "key-raft",
        savedAt: 1_000,
        reholdCount: 2,
        seenUpToSeq: 12,
      },
    },
  });

  expect(await found(store, "@ada")).toEqual({
    target: "@ada",
    content: "raft reply",
    idempotencyKey: "key-raft",
    reholdCount: 2,
    seenUpToSeq: 12,
    savedAt: 1_000,
  });
});

test("keeps a draft's exact seen sequences, in Raft 1.0.38's field, deduplicated and bounded", async () => {
  const stateDirectory = temporaryStateDirectory();
  const store = new AgentMessageDraftStore("agent-a", stateDirectory, () => 1_000);

  await store.save("@ada", { content: "reply", idempotencyKey: "key-1", seenExactSeqs: [6, 9] });
  expect((await found(store, "@ada"))?.seenExactSeqs).toEqual([6, 9]);
  expect(
    JSON.parse(await readFile(draftFile(stateDirectory), "utf8")).targets["@ada"],
  ).toMatchObject({
    seenExactSeqs: [6, 9],
  });

  // Raft's reader keeps the distinct positive integers, the newest 2500.
  await writeDraftFile(stateDirectory, {
    targets: {
      "@ada": {
        content: "raft reply",
        idempotencyKey: "key-raft",
        savedAt: 1_000,
        seenExactSeqs: [4, 4, 0, 2.5, ...Array.from({ length: 2600 }, (_, index) => index + 10)],
      },
    },
  });
  const read = (await found(store, "@ada"))?.seenExactSeqs ?? [];
  expect(read).toHaveLength(2500);
  expect(read.at(-1)).toBe(2609);
});

test("a draft without an idempotency key names no logical send and reads as missing", async () => {
  const stateDirectory = temporaryStateDirectory();
  const store = new AgentMessageDraftStore("agent-a", stateDirectory, () => 1_000);
  await writeDraftFile(stateDirectory, {
    targets: {
      "@ada": { content: "keyless", attachmentIds: [], savedAt: 1_000, reholdCount: 1 },
      "#general": { content: "blank key", idempotencyKey: " ", savedAt: 1_000 },
    },
  });

  expect(await store.lookup("@ada")).toEqual({ status: "missing" });
  expect(await store.lookup("#general")).toEqual({ status: "missing" });
});

test("a revised send replaces the draft and resets its hold count", async () => {
  const stateDirectory = temporaryStateDirectory();
  const store = new AgentMessageDraftStore("agent-a", stateDirectory, () => 1_000);
  await store.replace("@ada", {
    content: "first reply",
    idempotencyKey: "key-1",
    reholdCount: 1,
    seenUpToSeq: 9,
  });

  await store.save("@ada", { content: "changed reply", idempotencyKey: "key-2" });

  expect(await found(store, "@ada")).toEqual({
    target: "@ada",
    content: "changed reply",
    idempotencyKey: "key-2",
    reholdCount: 0,
    savedAt: 1_000,
  });
});

test("keeps the logical send's idempotency key through a held refresh", async () => {
  const stateDirectory = temporaryStateDirectory();
  const store = new AgentMessageDraftStore("agent-a", stateDirectory, () => 1_000);
  await store.save("@ada", { content: "draft reply", idempotencyKey: "key-1" });

  await store.replace("@ada", { content: "draft reply", reholdCount: 1, idempotencyKey: "key-1" });

  expect((await found(store, "@ada"))?.idempotencyKey).toBe("key-1");
});

test("an expired draft is reported once with its last body; only the looked-up target is removed", async () => {
  const stateDirectory = temporaryStateDirectory();
  let now = 1_000;
  const store = new AgentMessageDraftStore("agent-a", stateDirectory, () => now);
  await store.save("@ada", { content: "stale reply", idempotencyKey: "key-1" });
  await store.save("#general", { content: "other stale reply", idempotencyKey: "key-2" });

  now += AGENT_MESSAGE_DRAFT_TTL_MS + 1;

  expect(await store.lookup("@ada")).toEqual({
    status: "expired",
    content: "stale reply",
    savedAt: 1_000,
  });
  expect(await store.lookup("@ada")).toEqual({ status: "missing" });
  // Raft's `lookupSavedDraft` removes only its own target: another target's expired draft still
  // reports itself, with its last body.
  expect(await store.lookup("#general")).toEqual({
    status: "expired",
    content: "other stale reply",
    savedAt: 1_000,
  });
});

test("writing one target's draft never drops another target's expired draft", async () => {
  const stateDirectory = temporaryStateDirectory();
  let now = 1_000;
  const store = new AgentMessageDraftStore("agent-a", stateDirectory, () => now);
  await store.save("@ada", { content: "draft for ada", idempotencyKey: "key-ada" });

  now += AGENT_MESSAGE_DRAFT_TTL_MS + 1;
  await store.save("#general", { content: "draft for general", idempotencyKey: "key-general" });
  await store.replace("#general", {
    content: "draft for general",
    idempotencyKey: "key-general",
    reholdCount: 1,
  });
  expect(await store.clearIfIdempotencyKeyMatches("#general", "key-general")).toBe(true);
  await store.clear("#general");

  expect(await store.lookup("@ada")).toEqual({
    status: "expired",
    content: "draft for ada",
    savedAt: 1_000,
  });
});

test("an idempotency key is kept exactly as written; only a blank one reads as missing", async () => {
  const stateDirectory = temporaryStateDirectory();
  const store = new AgentMessageDraftStore("agent-a", stateDirectory, () => 1_000);
  await writeDraftFile(stateDirectory, {
    targets: { "@ada": { content: "spaced", idempotencyKey: " key-1 ", savedAt: 1_000 } },
  });

  expect((await found(store, "@ada"))?.idempotencyKey).toBe(" key-1 ");
  expect(await store.clearIfIdempotencyKeyMatches("@ada", "key-1")).toBe(false);
});

test("clears a draft only for the send whose idempotency key it holds, and never an expired one", async () => {
  const stateDirectory = temporaryStateDirectory();
  let now = 1_000;
  const store = new AgentMessageDraftStore("agent-a", stateDirectory, () => now);
  await store.save("@ada", { content: "newer draft", idempotencyKey: "key-new" });

  expect(await store.clearIfIdempotencyKeyMatches("@ada", "key-old")).toBe(false);
  expect((await found(store, "@ada"))?.content).toBe("newer draft");

  expect(await store.clearIfIdempotencyKeyMatches("@ada", "key-new")).toBe(true);
  expect(await store.lookup("@ada")).toEqual({ status: "missing" });

  await store.save("@ada", { content: "stale draft", idempotencyKey: "key-stale" });
  now += AGENT_MESSAGE_DRAFT_TTL_MS + 1;
  expect(await store.clearIfIdempotencyKeyMatches("@ada", "key-stale")).toBe(false);
});

function temporaryStateDirectory() {
  const path = join(tmpdir(), `coforge-agent-drafts-${crypto.randomUUID()}`);
  directories.push(path);
  return path;
}

function draftFile(root: string) {
  return join(userDirectory(root), "agent-a", "continue-state.json");
}

async function writeDraftFile(root: string, contents: unknown) {
  await mkdir(join(userDirectory(root), "agent-a"), { recursive: true, mode: 0o700 });
  await Bun.write(draftFile(root), JSON.stringify(contents));
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
    await first.save("@ada", { content: "first user's reply", idempotencyKey: "key-1" });
    identity.mockReturnValue(1009);
    const second = new AgentMessageDraftStore("shared-agent", stateDirectory);
    identity.mockReturnValue(uid);
    expect(await second.lookup("@ada")).toEqual({ status: "missing" });
    await second.save("@ada", { content: "second user's reply", idempotencyKey: "key-2" });
    expect((await found(first, "@ada"))?.content).toBe("first user's reply");
    expect((await found(second, "@ada"))?.content).toBe("second user's reply");
    await second.clear("@ada");
    expect((await found(first, "@ada"))?.content).toBe("first user's reply");
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
  await expect(
    store.save("@ada", { content: "private reply", idempotencyKey: "key-1" }),
  ).rejects.toThrow("draft directory");
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
      await expect(
        store.save("@ada", { content: "private reply", idempotencyKey: "key-1" }),
      ).rejects.toThrow("owned by the current user");
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
    await store.save("@ada", { content: "private reply", idempotencyKey: "key-1" });
    expect((await stat(user)).mode & 0o777).toBe(0o700);
    expect((await stat(agent)).mode & 0o777).toBe(0o700);
    expect((await stat(join(agent, "continue-state.json"))).mode & 0o777).toBe(0o600);
    await store.clear("@ada");
    expect(await store.lookup("@ada")).toEqual({ status: "missing" });
  },
);

test("rejects a linked Agent directory for reads and cleanup", async () => {
  const root = temporaryStateDirectory();
  const outside = temporaryStateDirectory();
  await mkdir(userDirectory(root), { recursive: true });
  await mkdir(outside, { recursive: true });
  await Bun.write(
    join(outside, "continue-state.json"),
    JSON.stringify({ targets: { "@ada": { content: "x", savedAt: 1_000 } } }),
  );
  await symlink(
    outside,
    join(userDirectory(root), "agent-a"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const store = new AgentMessageDraftStore("agent-a", root);
  await expect(store.lookup("@ada")).rejects.toThrow("draft directory");
  await expect(store.clear("@ada")).rejects.toThrow("draft directory");
  expect(await Bun.file(join(outside, "continue-state.json")).exists()).toBe(true);
});
