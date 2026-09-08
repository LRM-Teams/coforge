import { afterEach, expect, jest, test } from "bun:test";
import type { AgentRuntimeEvent } from "@coforge/agent";
import { ActivityTrajectory } from "../src/agent-runtime/activity-trajectory";

afterEach(() => jest.useRealTimers());

test("concatenates deltas and resets the 350ms quiet window before tool start", () => {
  jest.useFakeTimers();
  const output: AgentRuntimeEvent[] = [];
  const trajectory = new ActivityTrajectory((event) => output.push(event));
  trajectory.accept({ type: "text-delta", text: "Hello " });
  jest.advanceTimersByTime(349);
  trajectory.accept({ type: "text-delta", text: "world" });
  jest.advanceTimersByTime(349);
  expect(output).toEqual([]);
  jest.advanceTimersByTime(1);
  expect(output).toMatchObject([
    {
      type: "activity",
      activity: {
        detailKind: "model_response_started",
        detail: "",
        entries: [{ kind: "text", text: "Hello world" }],
      },
    },
  ]);
  trajectory.accept({ type: "text-delta", text: "Next" });
  trajectory.accept({ type: "tool-start", id: "1", name: "Read" });
  expect(output.slice(1)).toMatchObject([
    { type: "activity", activity: { entries: [{ kind: "text", text: "Next" }] } },
    { type: "tool-start", name: "Read" },
  ]);
  trajectory.dispose();
  jest.advanceTimersByTime(1000);
  expect(output).toHaveLength(3);
});

test("flushes kind and explicit lineage switches, termination and disposal exactly once", () => {
  jest.useFakeTimers();
  const output: AgentRuntimeEvent[] = [];
  const trajectory = new ActivityTrajectory((event) => output.push(event));
  trajectory.accept({ type: "thinking-delta", text: "Plan" });
  trajectory.accept({ type: "text-delta", text: "Parent" });
  trajectory.accept({ type: "text-delta", text: "Child", subagent: { parentToolUseId: "tool-1" } });
  trajectory.accept({
    type: "text-delta",
    text: "Sibling",
    subagent: { parentToolUseId: "tool-2" },
  });
  trajectory.accept({ type: "completed", status: "completed" });
  trajectory.dispose();
  trajectory.dispose();
  trajectory.accept({ type: "text-delta", text: "Late stale launch" });
  jest.advanceTimersByTime(1000);
  expect(output).toMatchObject([
    { activity: { entries: [{ kind: "thinking", text: "Plan" }] } },
    { activity: { entries: [{ kind: "text", text: "Parent" }] } },
    { activity: { entries: [{ text: "Child", subagent: { parentToolUseId: "tool-1" } }] } },
    { activity: { entries: [{ text: "Sibling", subagent: { parentToolUseId: "tool-2" } }] } },
    { type: "completed" },
  ]);
  expect(
    output.map((event) => (event.type === "activity" ? event.activity.detailKind : event.type)),
  ).toEqual([
    "thinking_started",
    "model_response_started",
    "model_response_started",
    "model_response_started",
    "completed",
  ]);
  const next: AgentRuntimeEvent[] = [];
  const replacement = new ActivityTrajectory((event) => next.push(event));
  replacement.accept({ type: "text-delta", text: "Fresh launch" });
  jest.advanceTimersByTime(350);
  expect(next).toMatchObject([{ activity: { entries: [{ text: "Fresh launch" }] } }]);
  replacement.dispose();
});

test("redacts assembled split secrets, keeps Unicode/ellipsis within bound and flushes before errors", () => {
  jest.useFakeTimers();
  const output: AgentRuntimeEvent[] = [];
  const trajectory = new ActivityTrajectory((event) => output.push(event));
  trajectory.accept({ type: "text-delta", text: "token=split" });
  trajectory.accept({ type: "text-delta", text: "-secret sk-exam" });
  trajectory.accept({ type: "text-delta", text: "ple Bearer private" });
  trajectory.accept({ type: "text-delta", text: "-value" });
  jest.advanceTimersByTime(350);
  expect(output).toMatchObject([
    { activity: { entries: [{ text: "token=[REDACTED] [REDACTED] Bearer [REDACTED]" }] } },
  ]);
  trajectory.accept({ type: "thinking-delta", text: "😀".repeat(5000) });
  const error = {
    type: "activity",
    activity: {
      detailKind: "runtime_error",
      level: "error",
      detail: "Provider wording",
      observedAtMs: Date.parse("2026-09-07T00:00:00Z"),
    },
  } as const;
  trajectory.accept(error);
  expect(output[1]).toMatchObject({ activity: { entries: [{ text: "😀".repeat(1999) + "…" }] } });
  expect(output[2]).toEqual(error);
  trajectory.dispose();
  jest.advanceTimersByTime(1000);
  expect(output).toHaveLength(3);
});
