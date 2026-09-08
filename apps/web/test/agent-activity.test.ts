import { expect, test } from "bun:test";
import {
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
      Array.from({ length: 105 }, (_, index) => entry(index + 1)),
    ),
  ).toHaveLength(100);
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
