import { afterEach, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
        join(stateDirectory, "coforge-cli-attested-send", "agent%2Fa", "continue-state.json"),
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
