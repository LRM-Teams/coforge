import { expect, test } from "bun:test";
import { AgentInboxStateMachine } from "../src/daemon-runtime/agent-inbox-state-machine";

test("daemon retains only a draft body and opaque server hold token", async () => {
  const inbox = new AgentInboxStateMachine();
  await inbox.save("@ada", "draft reply");
  expect(await inbox.draft("@ada")).toEqual({ body: "draft reply" });
  await inbox.replace("@ada", "draft reply", "opaque-token");
  expect(await inbox.draft("@ada")).toEqual({ body: "draft reply", holdToken: "opaque-token" });
  await inbox.save("@ada", "draft reply");
  expect(await inbox.draft("@ada")).toEqual({ body: "draft reply" });
  await inbox.clear("@ada");
  expect(await inbox.draft("@ada")).toBeUndefined();
});
