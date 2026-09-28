import { expect, test } from "bun:test";
import { createStore } from "@tanstack/react-store";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import {
  applyAgentDisplaySnapshot,
  applyAgentStatusEvent,
  type AgentStatusView,
} from "#src/features/agents/agent-status-realtime";
import { liveAgentDisplay } from "#src/features/agents/workspace-agents-realtime";

/**
 * An Agent's avatar in the message stream reads that one Agent's display from the app shell's
 * live Agent store by id, so a status or activity change for one Agent repaints only its own
 * avatars, never every message row.
 */
type Agent = {
  id: string;
  status: AgentStatusView;
  display?: AgentDisplaySnapshot;
  isExtra?: true;
};

const display = (agentId: string, revision: number): AgentDisplaySnapshot => ({
  protocolMajor: 1,
  workspaceId: "workspace-1",
  computerId: "computer-1",
  agentId,
  revision,
  activityKind: "working",
  detailKind: "running_command",
  detail: "Running command",
  entries: [{ kind: "tool_start", toolName: "shell" }],
  expiresAt: 50_000,
});

const agent = (id: string): Agent => ({
  id,
  status: {
    value: "active",
    expiresAt: 90_000,
    ordering: { daemonInstanceId: "daemon-1", clientSeq: 1, observedAtMs: 1_000 },
  },
  display: display(id, 1),
});

function watch(store: ReturnType<typeof createStore<Agent[]>>, agentId: string) {
  const told = { count: 0 };
  const subscription = createStore(() => liveAgentDisplay(store.state, agentId)).subscribe(() => {
    told.count++;
  });
  return { told, stop: () => subscription.unsubscribe() };
}

test("an Agent's display is read by id; a missing Agent or a roster placeholder reads nothing", () => {
  const agents = [agent("a"), agent("b"), { ...agent("extra"), isExtra: true as const }];
  expect(liveAgentDisplay(agents, "b")?.agentId).toBe("b");
  expect(liveAgentDisplay(agents, "gone")).toBeUndefined();
  expect(liveAgentDisplay(agents, "extra")).toBeUndefined();
});

test("one Agent's new activity is told to its own avatars only", () => {
  const store = createStore([agent("a"), agent("b")]);
  const a = watch(store, "a");
  const b = watch(store, "b");
  try {
    store.setState((agents) => applyAgentDisplaySnapshot(agents, display("a", 2)));
    expect(a.told.count).toBe(1);
    expect(b.told.count).toBe(0);
  } finally {
    a.stop();
    b.stop();
  }
});

test("a status lease refresh keeps every Agent's display, so no avatar repaints", () => {
  const store = createStore([agent("a"), agent("b")]);
  const a = watch(store, "a");
  try {
    store.setState((agents) =>
      applyAgentStatusEvent(agents, {
        agentId: "a",
        status: "active",
        expiresAt: 120_000,
        daemonInstanceId: "daemon-1",
        clientSeq: 2,
        observedAtMs: 2_000,
      }),
    );
    expect(a.told.count).toBe(0);
  } finally {
    a.stop();
  }
});
