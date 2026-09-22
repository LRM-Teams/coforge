import { expect, test } from "bun:test";
import { CAUSAL_OPENVIKING_TOOL_PROFILE, OPENVIKING_TOOL_PROFILE } from "@lrm/coforge-sdk/agent";
import { createMemoryAgentFenceLookup, memoryAgentFenceForDesired } from "./memory-agent-fence";
import { createDefaultWorkspaceMemoryProfile } from "./profile";
import { createInMemoryWorkspaceMemoryProfileStore } from "./stores";

test("maps Workspace Memory Profile to the injected Memory Agent fence", () => {
  expect(memoryAgentFenceForDesired("openviking")).toBe(OPENVIKING_TOOL_PROFILE);
  expect(memoryAgentFenceForDesired("causal_openviking")).toBe(CAUSAL_OPENVIKING_TOOL_PROFILE);
  expect(memoryAgentFenceForDesired("off")).toBeUndefined();
  expect(memoryAgentFenceForDesired(null)).toBeUndefined();
});

test("store lookup returns the fence without exposing profile selection to callers", async () => {
  const store = createInMemoryWorkspaceMemoryProfileStore();
  await store.compareAndSet({
    workspaceId: "ws-a",
    expectedGeneration: 0,
    profile: { ...createDefaultWorkspaceMemoryProfile("ws-a"), desired: "openviking" },
  });
  const lookup = createMemoryAgentFenceLookup(store);
  expect(await lookup.resolve("ws-a")).toBe(OPENVIKING_TOOL_PROFILE);
  expect(await lookup.resolve("missing")).toBeUndefined();
});
