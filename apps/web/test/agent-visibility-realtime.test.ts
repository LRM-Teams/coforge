import { expect, test } from "bun:test";

import { createAgentVisibilityChangedPublisher } from "#src/server/agents/agent-visibility-realtime.server";
import { agentStatusChannel } from "#src/features/agents/agent-status-realtime";

// After a visibility change commits, every already-connected browser learns about it
// through the existing shared status channel — no new subscription, and the event carries only
// the Agent id, nothing a viewer without the roster doesn't already know.
test("publishes an id-only event on the shared status channel", async () => {
  const published: Array<{ channel: string; data: unknown }> = [];
  const publish = createAgentVisibilityChangedPublisher({
    publishJson: async (channel, data) => {
      published.push({ channel, data });
    },
  });

  await publish("workspace-1", "agent-1");

  expect(published).toEqual([
    {
      channel: agentStatusChannel("workspace-1"),
      data: { type: "agent:visibility_changed", agentId: "agent-1" },
    },
  ]);
});

test("propagates a publish failure rather than swallowing it", async () => {
  const publish = createAgentVisibilityChangedPublisher({
    publishJson: async () => {
      throw new Error("Centrifugo unavailable");
    },
  });

  await expect(publish("workspace-1", "agent-1")).rejects.toThrow("Centrifugo unavailable");
});
