import { expect, test } from "bun:test";
import { AgentInboxStateMachine } from "../src/daemon-runtime/agent-inbox-state-machine";

test("daemon retains only a draft body and opaque server hold token", () => {
  const inbox = new AgentInboxStateMachine();
  inbox.save("@ada", "draft reply");
  expect(inbox.draft("@ada")).toEqual({ body: "draft reply" });
  inbox.replace("@ada", "draft reply", "opaque-token");
  expect(inbox.draft("@ada")).toEqual({ body: "draft reply", holdToken: "opaque-token" });
  inbox.clear("@ada");
  expect(inbox.draft("@ada")).toBeUndefined();
});
