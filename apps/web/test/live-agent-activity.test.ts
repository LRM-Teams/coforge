import { expect, test } from "bun:test";

import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import { selectLiveAgentActivity } from "../src/features/conversations/live-agent-activity";

function agent(id: string, displayName: string, display?: Partial<AgentDisplaySnapshot>) {
  return {
    id,
    displayName,
    ...(display
      ? {
          display: {
            protocolMajor: 1 as const,
            workspaceId: "workspace-1",
            computerId: "computer-1",
            agentId: id,
            revision: 1,
            activityKind: "online" as const,
            detailKind: "idle",
            detail: "",
            entries: [],
            expiresAt: null,
            ...display,
          },
        }
      : {}),
  };
}

test("picks the working Agent with the newest display revision", () => {
  const selected = selectLiveAgentActivity([
    agent("ada", "Ada", { activityKind: "working", detail: "Reading the plan", revision: 4 }),
    agent("bea", "Bea", { activityKind: "thinking", detail: "", revision: 9 }),
    agent("cy", "Cy", { activityKind: "online", detail: "Idle", revision: 20 }),
  ]);

  expect(selected).toEqual({
    agentId: "bea",
    displayName: "Bea",
    avatarUrl: null,
    label: "Thinking…",
    tone: "thinking",
    pulse: true,
    display: {
      protocolMajor: 1,
      workspaceId: "workspace-1",
      computerId: "computer-1",
      agentId: "bea",
      revision: 9,
      activityKind: "thinking",
      detailKind: "idle",
      detail: "",
      entries: [],
      expiresAt: null,
    },
  });
});

test("keeps a working Agent ahead of a merely online one even when the online revision is newer", () => {
  const selected = selectLiveAgentActivity([
    agent("ada", "Ada", {
      activityKind: "working",
      detailKind: "model_request_started",
      detail: "Message received",
      revision: 2,
    }),
    agent("bea", "Bea", { activityKind: "online", revision: 80 }),
  ]);

  expect(selected?.agentId).toBe("ada");
  expect(selected?.label).toBe("Message received");
});

test("returns nothing when every Agent is idle, offline, unknown, or has no display", () => {
  expect(
    selectLiveAgentActivity([
      agent("ada", "Ada", { activityKind: "online", revision: 3 }),
      agent("bea", "Bea", { activityKind: "offline", revision: 8, expiresAt: null }),
      agent("cy", "Cy"),
    ]),
  ).toBeNull();
  expect(selectLiveAgentActivity([])).toBeNull();
});

test("an error stays visible and outranks an older working Agent", () => {
  const selected = selectLiveAgentActivity([
    agent("ada", "Ada", { activityKind: "working", detail: "Editing files", revision: 2 }),
    agent("bea", "Bea", {
      activityKind: "error",
      detailKind: "runtime_error",
      detail: "Provider rejected request",
      revision: 5,
    }),
  ]);

  expect(selected).toMatchObject({
    agentId: "bea",
    label: "Error: Provider rejected request",
    tone: "error",
    pulse: false,
  });
});

test("equal revisions keep the earlier Agent so the strip does not flicker", () => {
  const selected = selectLiveAgentActivity([
    agent("ada", "Ada", { activityKind: "working", detail: "First", revision: 4 }),
    agent("bea", "Bea", { activityKind: "working", detail: "Second", revision: 4 }),
  ]);

  expect(selected?.agentId).toBe("ada");
});
