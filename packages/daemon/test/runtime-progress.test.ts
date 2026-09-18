import { expect, test } from "bun:test";
import { RuntimeProgressTracker } from "../src/agent-runtime/runtime-progress";

test("observe announces when the Agent is not already busy", () => {
  const tracker = new RuntimeProgressTracker();
  let announced = 0;
  tracker.observe("agent-a", false, () => announced++);
  expect(announced).toBe(1);
});

test("observe does not announce when the Agent is already visibly busy", () => {
  const tracker = new RuntimeProgressTracker();
  let announced = 0;
  tracker.observe("agent-a", true, () => announced++);
  expect(announced).toBe(0);
});

test("observe refreshes liveness bookkeeping whether or not it announces", () => {
  const tracker = new RuntimeProgressTracker();
  expect(tracker.lastObservedAtMs("agent-a")).toBeUndefined();
  tracker.observe("agent-a", true, () => {});
  const first = tracker.lastObservedAtMs("agent-a");
  expect(first).toBeDefined();
  tracker.observe("agent-a", false, () => {});
  expect(tracker.lastObservedAtMs("agent-a")).toBeGreaterThanOrEqual(first!);
});

test("each Agent's liveness bookkeeping is independent", () => {
  const tracker = new RuntimeProgressTracker();
  tracker.observe("agent-a", false, () => {});
  expect(tracker.lastObservedAtMs("agent-a")).toBeDefined();
  expect(tracker.lastObservedAtMs("agent-b")).toBeUndefined();
});

test("dispose forgets one Agent's bookkeeping", () => {
  const tracker = new RuntimeProgressTracker();
  tracker.observe("agent-a", false, () => {});
  tracker.dispose("agent-a");
  expect(tracker.lastObservedAtMs("agent-a")).toBeUndefined();
});

test("disposeAll forgets every Agent's bookkeeping", () => {
  const tracker = new RuntimeProgressTracker();
  tracker.observe("agent-a", false, () => {});
  tracker.observe("agent-b", false, () => {});
  tracker.disposeAll();
  expect(tracker.lastObservedAtMs("agent-a")).toBeUndefined();
  expect(tracker.lastObservedAtMs("agent-b")).toBeUndefined();
});
