import { expect, test } from "bun:test";
import { AgentInboxStateMachine } from "../src/daemon-runtime/agent-inbox-state-machine";

test("daemon retains the draft text and the count of holds it has taken", async () => {
  const inbox = new AgentInboxStateMachine();
  await inbox.save("@ada", "draft reply");
  expect(await inbox.draft("@ada")).toEqual({ content: "draft reply", reholdCount: 0 });
  await inbox.replace("@ada", "draft reply");
  expect(await inbox.draft("@ada")).toEqual({ content: "draft reply", reholdCount: 1 });
  await inbox.replace("@ada", "draft reply");
  expect(await inbox.draft("@ada")).toEqual({ content: "draft reply", reholdCount: 2 });
  // A revised send replaces the draft and is a fresh attempt, not another hold.
  await inbox.save("@ada", "revised reply");
  expect(await inbox.draft("@ada")).toEqual({ content: "revised reply", reholdCount: 0 });
  await inbox.clear("@ada");
  expect(await inbox.draft("@ada")).toBeUndefined();
});
