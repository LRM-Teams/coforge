import { expect, test } from "bun:test";
import { encodeAgentActivity } from "@lrm/coforge-sdk/internal";
import {
  decodeActivityObservation,
  latestActivityError,
  mergeAgentActivity,
  type ActivityEntry,
} from "../src/features/agents/agent-activity";

function entry(clientSeq: number, id = `live-${clientSeq}`): ActivityEntry {
  return {
    id,
    launchId: "launch-1",
    clientSeq,
    detailKind: "tool_started",
    level: "info",
    detail: "Tool",
    observedAtMs: clientSeq * 1000,
    entries: [],
  };
}

const baseWireActivity = {
  protocolMajor: 1,
  requestId: "request-1",
  workspaceId: "workspace-1",
  agentId: "agent-1",
  detailKind: "tool_started",
  level: "info" as const,
  detail: "Tool",
  observedAtMs: 1000,
  launchId: "launch-1",
  clientSeq: 1,
};

test("decodeActivityObservation drops a busy heartbeat frame", () => {
  const decoded = decodeActivityObservation(
    encodeAgentActivity({ ...baseWireActivity, isHeartbeat: true, entries: [] }),
    { workspaceId: "workspace-1" },
  );
  expect(decoded).toBeUndefined();
});

test("decodeActivityObservation drops a reply to the server's own liveness probe", () => {
  const decoded = decodeActivityObservation(
    encodeAgentActivity({ ...baseWireActivity, probeId: "probe-1", entries: [] }),
    { workspaceId: "workspace-1" },
  );
  expect(decoded).toBeUndefined();
});

test("decodeActivityObservation drops a content-free runtime_progress frame", () => {
  const decoded = decodeActivityObservation(
    encodeAgentActivity({ ...baseWireActivity, detailKind: "runtime_progress", detail: "" }),
    { workspaceId: "workspace-1" },
  );
  expect(decoded).toBeUndefined();
});

// A content-free run-start marker (no entries, empty detail) only flips the display status;
// the same detail kind with real entries is the actual Thinking/Output row and must survive.
test.each(["thinking_started", "model_response_started"])(
  "decodeActivityObservation drops a content-free %s run-start marker",
  (detailKind) => {
    const decoded = decodeActivityObservation(
      encodeAgentActivity({ ...baseWireActivity, detailKind, detail: "", entries: [] }),
      { workspaceId: "workspace-1" },
    );
    expect(decoded).toBeUndefined();
  },
);

test.each(["thinking_started", "model_response_started"])(
  "decodeActivityObservation keeps a %s flush that carries real entries",
  (detailKind) => {
    const decoded = decodeActivityObservation(
      encodeAgentActivity({
        ...baseWireActivity,
        detailKind,
        detail: "",
        entries: [{ kind: "text", text: "hello" }],
      }),
      { workspaceId: "workspace-1" },
    );
    expect(decoded?.entry.detailKind).toBe(detailKind);
  },
);

// ADR 0021, amended: tool_end/thinking_end/compaction_finished are ordinary status
// observations now (persisted and shown live); only runtime_progress stays a
// content-free liveness filler.
test.each([
  "tool_end",
  "thinking_end",
  "compaction_finished",
  "compacting_context",
  "subagent_activity",
  "message_received",
])("decodeActivityObservation keeps a visible %s activity, content-free or not", (detailKind) => {
  const decoded = decodeActivityObservation(
    encodeAgentActivity({ ...baseWireActivity, detailKind, detail: "" }),
    { workspaceId: "workspace-1" },
  );
  expect(decoded?.entry.detailKind).toBe(detailKind);
});

test("decodeActivityObservation keeps an ordinary busy activity", () => {
  const decoded = decodeActivityObservation(encodeAgentActivity(baseWireActivity), {
    workspaceId: "workspace-1",
  });
  expect(decoded?.entry.detailKind).toBe("tool_started");
});

test("mergeAgentActivity drops runtime_progress entries even if not decoded away", () => {
  const result = mergeAgentActivity(
    [],
    [entry(1), { ...entry(2), detailKind: "runtime_progress" }],
  );
  expect(result.map((value) => value.clientSeq)).toEqual([1]);
});

// ADR 0021, amended: unlike runtime_progress, these are ordinary Activity now.
test.each(["tool_end", "thinking_end", "compaction_finished"])(
  "mergeAgentActivity keeps %s entries",
  (detailKind) => {
    const result = mergeAgentActivity([], [entry(1), { ...entry(2), detailKind }]);
    expect(result.map((value) => value.clientSeq)).toEqual([2, 1]);
  },
);

test("merges delayed history with live activity without duplicates or lost publications", () => {
  const live = mergeAgentActivity([entry(1)], [entry(3), entry(2)]);
  const result = mergeAgentActivity(live, [entry(2, "persisted-2"), entry(1, "persisted-1")]);
  expect(result.map((value) => value.id)).toEqual(["live-3", "persisted-2", "persisted-1"]);
  expect(mergeAgentActivity(result, [entry(2, "persisted-2")])).toEqual(result);
});

test("keeps separate launches and bounds the newest-first observation window", () => {
  const result = mergeAgentActivity(
    [entry(1)],
    [{ ...entry(1), id: "new-launch", launchId: "launch-2" }],
  );
  expect(result).toHaveLength(2);
  expect(
    mergeAgentActivity(
      [],
      Array.from({ length: 505 }, (_, index) => entry(index + 1)),
    ),
  ).toHaveLength(500);
});

test("launch sequence wins over skewed timestamps when deciding recovery", () => {
  const failure = { ...entry(1), detailKind: "runtime_error", level: "error", observedAtMs: 9000 };
  const recovery = { ...entry(2), detailKind: "model_response_started", observedAtMs: 8000 };
  expect(mergeAgentActivity([failure], [recovery]).map((value) => value.clientSeq)).toEqual([2, 1]);
  expect(latestActivityError([failure, recovery])).toBeUndefined();
});

test("sequences from different launches do not override server observation order", () => {
  const failure = {
    ...entry(99),
    detailKind: "runtime_error",
    level: "error",
    observedAtMs: 1000,
  };
  const recovery = {
    ...entry(1),
    launchId: "launch-2",
    detailKind: "starting",
    observedAtMs: 1000,
  };
  expect(latestActivityError(mergeAgentActivity([failure], [recovery]))).toBeUndefined();
});

test("a delayed publication does not replace its persisted metadata", () => {
  const persisted = entry(1, "persisted-1");
  const live = { ...persisted, id: undefined };
  expect(mergeAgentActivity([persisted], [live])).toEqual([persisted]);
});

// Invariant (b): tool_end/thinking_end/compaction_finished now existing in the merged
// list (ADR 0021, amended) must not change latestActivityError/recoveredKinds — neither
// is a recognized recovery kind and neither is level "error", so `.find`/`.some` skip
// straight past them exactly as they would any other unrelated info-level entry.
test("tool_end/thinking_end/compaction_finished rows do not change latestActivityError (invariant b)", () => {
  const failure = { ...entry(1), detailKind: "runtime_error", level: "error", observedAtMs: 1000 };
  const recovery = { ...entry(2), detailKind: "model_response_started", observedAtMs: 2000 };
  const noise = ["tool_end", "thinking_end", "compaction_finished"].map((detailKind, index) => ({
    ...entry(3 + index),
    detailKind,
    observedAtMs: 3000 + index * 100,
  }));
  const withoutNoise = latestActivityError(mergeAgentActivity([failure], [recovery]));
  const withNoise = latestActivityError(mergeAgentActivity([failure], [recovery, ...noise]));
  expect(withNoise).toEqual(withoutNoise);
  expect(withNoise).toBeUndefined();

  // Same check when the failure is the newest entry (still unrecovered either way).
  const laterFailure = {
    ...entry(9),
    detailKind: "runtime_error",
    level: "error",
    observedAtMs: 9000,
  };
  expect(latestActivityError(mergeAgentActivity([laterFailure], [recovery]))?.id).toEqual(
    latestActivityError(mergeAgentActivity([laterFailure], [recovery, ...noise]))?.id,
  );
});
