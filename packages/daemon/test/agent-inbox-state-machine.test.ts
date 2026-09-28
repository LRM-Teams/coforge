import { expect, test } from "bun:test";
import { AgentInboxStateMachine } from "#src/daemon-runtime/agent-inbox-state-machine";

test("daemon retains the draft text and the count of holds it has taken", async () => {
  const inbox = new AgentInboxStateMachine();
  await inbox.save("@ada", { content: "draft reply" });
  expect(await inbox.draft("@ada")).toEqual({ content: "draft reply", reholdCount: 0 });
  // Raft's held refresh: the same content, one hold later, remembering the reviewed frontier.
  await inbox.replace("@ada", { content: "draft reply", reholdCount: 1, seenUpToSeq: 9 });
  expect(await inbox.draft("@ada")).toEqual({
    content: "draft reply",
    reholdCount: 1,
    seenUpToSeq: 9,
  });
  await inbox.replace("@ada", { content: "draft reply", reholdCount: 2, seenUpToSeq: 12 });
  expect(await inbox.draft("@ada")).toEqual({
    content: "draft reply",
    reholdCount: 2,
    seenUpToSeq: 12,
  });
  // A revised send replaces the draft and is a fresh attempt, not another hold.
  await inbox.save("@ada", { content: "revised reply" });
  expect(await inbox.draft("@ada")).toEqual({ content: "revised reply", reholdCount: 0 });
  await inbox.clear("@ada");
  expect(await inbox.draft("@ada")).toBeUndefined();
});

test("an in-memory draft keeps Raft's attachmentIds, mentions and seenUpToSeq", async () => {
  const inbox = new AgentInboxStateMachine();
  const mentions = [{ type: "user" as const, id: "actor-1", name: "ada" }];
  await inbox.replace("@ada", {
    content: "draft reply",
    reholdCount: 1,
    attachmentIds: ["attachment-1"],
    mentions,
    seenUpToSeq: 9,
  });
  expect(await inbox.draft("@ada")).toEqual({
    content: "draft reply",
    reholdCount: 1,
    attachmentIds: ["attachment-1"],
    mentions,
    seenUpToSeq: 9,
  });
});
