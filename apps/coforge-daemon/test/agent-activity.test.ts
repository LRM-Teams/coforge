import { expect, test } from "bun:test";
import { createAgentActivity } from "../src/agent-runtime/agent-activity";

test("creates one provider-neutral activity shape for commands and diagnostics", () => {
  expect(
    createAgentActivity("running_command", "info", "bun test", "2026-08-27T00:00:00.000Z"),
  ).toEqual({
    activity: "running_command",
    level: "info",
    message: "bun test",
    occurredAt: "2026-08-27T00:00:00.000Z",
  });
});
