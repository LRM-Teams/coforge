import { afterEach, expect, jest, test } from "bun:test";
import type { AgentRuntimeEvent } from "@coforge/agent";
import { ActivityTrajectory } from "../src/agent-runtime/activity-trajectory";

afterEach(() => jest.useRealTimers());

/** The detail kind of an activity event, or the event's own type for anything else. */
function kinds(events: AgentRuntimeEvent[]) {
  return events.map((event) =>
    event.type === "activity" ? event.activity.detailKind : event.type,
  );
}

test("concatenates deltas and resets the 350ms quiet window before tool start", () => {
  jest.useFakeTimers();
  const output: AgentRuntimeEvent[] = [];
  const trajectory = new ActivityTrajectory((event) => output.push(event));
  trajectory.accept({ type: "text-delta", text: "Hello " });
  // The run's kind is announced content-free the instant it starts, not on a debounce.
  expect(output).toMatchObject([
    { activity: { detailKind: "model_response_started", detail: "" } },
  ]);
  jest.advanceTimersByTime(349);
  trajectory.accept({ type: "text-delta", text: "world" });
  jest.advanceTimersByTime(349);
  expect(output).toHaveLength(1);
  jest.advanceTimersByTime(1);
  expect(output).toMatchObject([
    { activity: { detailKind: "model_response_started", detail: "" } },
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
  // No re-announcement: the kind hasn't changed since the last one.
  expect(output.slice(2)).toMatchObject([
    { activity: { entries: [{ kind: "text", text: "Next" }] } },
    { type: "tool-start", name: "Read" },
  ]);
  trajectory.dispose();
  jest.advanceTimersByTime(1000);
  expect(output).toHaveLength(4);
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
  expect(kinds(output)).toEqual([
    "thinking_started", // run-start announcement
    "thinking_started", // entry: "Plan"
    "thinking_end", // text-delta below moved the model on
    "model_response_started", // run-start announcement
    "model_response_started", // entry: "Parent" (lineage switch flushed it)
    "model_response_started", // entry: "Child" (a different subagent flushed it)
    "model_response_started", // entry: "Sibling"
    "completed",
  ]);
  expect(output).toMatchObject([
    { activity: { detailKind: "thinking_started" } },
    { activity: { entries: [{ kind: "thinking", text: "Plan" }] } },
    { activity: { detailKind: "thinking_end" } },
    { activity: { detailKind: "model_response_started" } },
    { activity: { entries: [{ kind: "text", text: "Parent" }] } },
    { activity: { entries: [{ text: "Child", subagent: { parentToolUseId: "tool-1" } }] } },
    { activity: { entries: [{ text: "Sibling", subagent: { parentToolUseId: "tool-2" } }] } },
    { type: "completed" },
  ]);
  expect(
    (output[0] as Extract<AgentRuntimeEvent, { type: "activity" }>).activity.entries,
  ).toBeUndefined();
  expect(
    (output[3] as Extract<AgentRuntimeEvent, { type: "activity" }>).activity.entries,
  ).toBeUndefined();
  const next: AgentRuntimeEvent[] = [];
  const replacement = new ActivityTrajectory((event) => next.push(event));
  replacement.accept({ type: "text-delta", text: "Fresh launch" });
  jest.advanceTimersByTime(350);
  expect(kinds(next)).toEqual(["model_response_started", "model_response_started"]);
  expect(next[1]).toMatchObject({ activity: { entries: [{ text: "Fresh launch" }] } });
  replacement.dispose();
});

test("compaction-started/-finished/-interrupted flush pending text first; a progress event never does", () => {
  jest.useFakeTimers();
  const output: AgentRuntimeEvent[] = [];
  const trajectory = new ActivityTrajectory((event) => output.push(event));
  const kinds = () =>
    output.map((event) =>
      event.type === "activity"
        ? `${event.activity.detailKind}${event.activity.entries ? ":text" : ""}`
        : event.type,
    );
  trajectory.accept({ type: "text-delta", text: "before compaction" });
  trajectory.accept({ type: "compaction-started" });
  expect(kinds()).toEqual([
    "model_response_started",
    "model_response_started:text",
    "compaction-started",
  ]);
  trajectory.accept({ type: "text-delta", text: "mid" });
  trajectory.accept({ type: "compaction-finished" });
  expect(kinds().slice(3)).toEqual(["model_response_started:text", "compaction-finished"]);
  trajectory.accept({ type: "text-delta", text: "more" });
  trajectory.accept({ type: "compaction-interrupted" });
  expect(kinds().slice(5)).toEqual(["model_response_started:text", "compaction-interrupted"]);
  // A progress event does not flush: the buffered text is still pending afterward.
  trajectory.accept({ type: "text-delta", text: "still buffering" });
  trajectory.accept({ type: "progress" });
  expect(kinds().slice(7)).toEqual(["progress"]);
  jest.advanceTimersByTime(350);
  expect(output.slice(8)).toMatchObject([{ activity: { entries: [{ text: "still buffering" }] } }]);
  trajectory.dispose();
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
  expect(output[1]).toMatchObject({
    activity: { entries: [{ text: "token=[REDACTED] [REDACTED] Bearer [REDACTED]" }] },
  });
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
  expect(kinds(output)).toEqual([
    "model_response_started", // run-start announcement
    "model_response_started", // entry: redacted text
    "thinking_started", // run-start announcement
    "thinking_started", // entry: truncated thinking, flushed by the error below
    "thinking_end", // the error moved the model on
    "runtime_error",
  ]);
  expect(output[3]).toMatchObject({ activity: { entries: [{ text: "😀".repeat(1999) + "…" }] } });
  expect(output[4]).toMatchObject({
    activity: { detailKind: "thinking_end", level: "info", detail: "Thinking finished" },
  });
  expect(
    (output[4] as Extract<AgentRuntimeEvent, { type: "activity" }>).activity.entries,
  ).toBeUndefined();
  expect(output[5]).toEqual(error);
  trajectory.dispose();
  jest.advanceTimersByTime(1000);
  expect(output).toHaveLength(6);
});

test("a thinking run ends before the text that follows it, which is flushed later", () => {
  jest.useFakeTimers();
  const output: AgentRuntimeEvent[] = [];
  const trajectory = new ActivityTrajectory((event) => output.push(event));
  trajectory.accept({ type: "thinking-delta", text: "Plan" });
  trajectory.accept({ type: "text-delta", text: "Answer" });
  jest.advanceTimersByTime(350);
  expect(kinds(output)).toEqual([
    "thinking_started",
    "thinking_started",
    "thinking_end",
    "model_response_started",
    "model_response_started",
  ]);
  expect(output[1]).toMatchObject({ activity: { entries: [{ kind: "thinking", text: "Plan" }] } });
  expect(output[4]).toMatchObject({ activity: { entries: [{ kind: "text", text: "Answer" }] } });
  trajectory.dispose();
});

test("a thinking run ends before a tool-start", () => {
  const output: AgentRuntimeEvent[] = [];
  const trajectory = new ActivityTrajectory((event) => output.push(event));
  trajectory.accept({ type: "thinking-delta", text: "Plan" });
  trajectory.accept({ type: "tool-start", id: "1", name: "Read" });
  expect(kinds(output)).toEqual([
    "thinking_started",
    "thinking_started",
    "thinking_end",
    "tool-start",
  ]);
  trajectory.dispose();
});

test("a thinking run ends before the turn completes", () => {
  const output: AgentRuntimeEvent[] = [];
  const trajectory = new ActivityTrajectory((event) => output.push(event));
  trajectory.accept({ type: "thinking-delta", text: "Plan" });
  trajectory.accept({ type: "completed", status: "completed" });
  expect(kinds(output)).toEqual([
    "thinking_started",
    "thinking_started",
    "thinking_end",
    "completed",
  ]);
  trajectory.dispose();
});

test("a thinking run ends before a tool-end", () => {
  const output: AgentRuntimeEvent[] = [];
  const trajectory = new ActivityTrajectory((event) => output.push(event));
  trajectory.accept({ type: "thinking-delta", text: "Plan" });
  trajectory.accept({ type: "tool-end", id: "1", isError: false });
  expect(kinds(output)).toEqual([
    "thinking_started",
    "thinking_started",
    "thinking_end",
    "tool-end",
  ]);
  trajectory.dispose();
});

test("a thinking run ends before a compaction activity", () => {
  const output: AgentRuntimeEvent[] = [];
  const trajectory = new ActivityTrajectory((event) => output.push(event));
  trajectory.accept({ type: "thinking-delta", text: "Plan" });
  trajectory.accept({
    type: "activity",
    activity: {
      detailKind: "compacting_context",
      level: "info",
      detail: "Compacting context…",
      observedAtMs: Date.now(),
    },
  });
  expect(kinds(output)).toEqual([
    "thinking_started",
    "thinking_started",
    "thinking_end",
    "compacting_context",
  ]);
  trajectory.dispose();
});

test("a thinking run ends before an error activity", () => {
  const output: AgentRuntimeEvent[] = [];
  const trajectory = new ActivityTrajectory((event) => output.push(event));
  trajectory.accept({ type: "thinking-delta", text: "Plan" });
  const error = {
    type: "activity",
    activity: {
      detailKind: "runtime_error",
      level: "error",
      detail: "Provider wording",
      observedAtMs: Date.now(),
    },
  } as const;
  trajectory.accept(error);
  expect(kinds(output)).toEqual([
    "thinking_started",
    "thinking_started",
    "thinking_end",
    "runtime_error",
  ]);
  expect(output[3]).toEqual(error);
  trajectory.dispose();
});

test("a subagent-scoped thinking run also gets thinking_end", () => {
  const output: AgentRuntimeEvent[] = [];
  const trajectory = new ActivityTrajectory((event) => output.push(event));
  trajectory.accept({
    type: "thinking-delta",
    text: "Plan",
    subagent: { parentToolUseId: "tool-1" },
  });
  trajectory.accept({ type: "tool-start", id: "2", name: "Read" });
  expect(kinds(output)).toEqual([
    "thinking_started",
    "thinking_started",
    "thinking_end",
    "tool-start",
  ]);
  expect(output[1]).toMatchObject({
    activity: {
      entries: [{ kind: "thinking", text: "Plan", subagent: { parentToolUseId: "tool-1" } }],
    },
  });
  trajectory.dispose();
});

test("an idle-timer split thinking run stays open until the model moves on: two thinking entries, one thinking_end", () => {
  jest.useFakeTimers();
  const output: AgentRuntimeEvent[] = [];
  const trajectory = new ActivityTrajectory((event) => output.push(event));
  trajectory.accept({ type: "thinking-delta", text: "A" });
  jest.advanceTimersByTime(400); // idle flush of the first chunk; the run stays open
  trajectory.accept({ type: "thinking-delta", text: "B" });
  trajectory.accept({ type: "text-delta", text: "C" });
  jest.advanceTimersByTime(350);
  expect(kinds(output)).toEqual([
    "thinking_started", // run-start announcement
    "thinking_started", // entry: "A", idle-flushed
    "thinking_started", // entry: "B", flushed by the text-delta below
    "thinking_end",
    "model_response_started", // run-start announcement
    "model_response_started", // entry: "C"
  ]);
  expect(output[1]).toMatchObject({ activity: { entries: [{ text: "A" }] } });
  expect(output[2]).toMatchObject({ activity: { entries: [{ text: "B" }] } });
  expect(
    output.filter(
      (event) => event.type === "activity" && event.activity.detailKind === "thinking_end",
    ),
  ).toHaveLength(1);
  trajectory.dispose();
});

test("a runtime_progress activity mid-thinking does not end the run", () => {
  jest.useFakeTimers();
  const output: AgentRuntimeEvent[] = [];
  const trajectory = new ActivityTrajectory((event) => output.push(event));
  trajectory.accept({ type: "thinking-delta", text: "A" });
  trajectory.accept({
    type: "activity",
    activity: {
      detailKind: "runtime_progress",
      level: "info",
      detail: "",
      observedAtMs: Date.now(),
    },
  });
  trajectory.accept({ type: "thinking-delta", text: "B" });
  trajectory.accept({ type: "text-delta", text: "C" });
  jest.advanceTimersByTime(350);
  expect(kinds(output)).toEqual([
    "thinking_started", // run-start announcement
    "thinking_started", // entry: "A", flushed by the runtime_progress ping
    "runtime_progress", // forwarded; never ends thinking or changes last-announced
    "thinking_started", // entry: "B", flushed by the text-delta below
    "thinking_end",
    "model_response_started", // run-start announcement
    "model_response_started", // entry: "C"
  ]);
  trajectory.dispose();
});

test("a text-only turn emits no thinking_end", () => {
  const output: AgentRuntimeEvent[] = [];
  const trajectory = new ActivityTrajectory((event) => output.push(event));
  trajectory.accept({ type: "text-delta", text: "Hello" });
  trajectory.accept({ type: "completed", status: "completed" });
  expect(kinds(output)).toEqual(["model_response_started", "model_response_started", "completed"]);
  expect(kinds(output)).not.toContain("thinking_end");
  trajectory.dispose();
});

test("two separate thinking runs in one launch each get their own thinking_end", () => {
  const output: AgentRuntimeEvent[] = [];
  const trajectory = new ActivityTrajectory((event) => output.push(event));
  trajectory.accept({ type: "thinking-delta", text: "First" });
  trajectory.accept({ type: "text-delta", text: "Reply one" });
  trajectory.accept({ type: "thinking-delta", text: "Second" });
  trajectory.accept({ type: "tool-start", id: "1", name: "Read" });
  expect(kinds(output)).toEqual([
    "thinking_started",
    "thinking_started",
    "thinking_end",
    "model_response_started",
    "model_response_started",
    "thinking_started", // re-announced: the last announced kind had changed
    "thinking_started",
    "thinking_end",
    "tool-start",
  ]);
  expect(
    output.filter(
      (event) => event.type === "activity" && event.activity.detailKind === "thinking_end",
    ),
  ).toHaveLength(2);
  trajectory.dispose();
});

test("announces a fresh run's kind immediately, content-free, and again after an intervening activity", () => {
  jest.useFakeTimers();
  const output: AgentRuntimeEvent[] = [];
  const trajectory = new ActivityTrajectory((event) => output.push(event));
  trajectory.accept({ type: "text-delta", text: "Hello" });
  expect(output).toHaveLength(1);
  expect(output[0]).toMatchObject({
    type: "activity",
    activity: { detailKind: "model_response_started", level: "info", detail: "" },
  });
  expect(
    (output[0] as Extract<AgentRuntimeEvent, { type: "activity" }>).activity.entries,
  ).toBeUndefined();
  trajectory.accept({ type: "text-delta", text: " world" }); // same run, same kind: no re-announce
  expect(output).toHaveLength(1);
  jest.advanceTimersByTime(350);
  expect(output).toHaveLength(2); // the flush carrying the entries
  trajectory.accept({
    type: "activity",
    activity: {
      detailKind: "tool_started",
      level: "info",
      detail: "",
      observedAtMs: Date.now(),
      entries: [{ kind: "tool_start", toolName: "Read" }],
    },
  });
  expect(output).toHaveLength(3);
  // Last-announced changed to tool_started, so the next text run re-announces.
  trajectory.accept({ type: "text-delta", text: "Again" });
  expect(output).toHaveLength(4);
  expect(output[3]).toMatchObject({
    activity: { detailKind: "model_response_started", detail: "" },
  });
  expect(
    (output[3] as Extract<AgentRuntimeEvent, { type: "activity" }>).activity.entries,
  ).toBeUndefined();
  trajectory.dispose();
});

test("dispose flushes pending text but never emits thinking_end", () => {
  const output: AgentRuntimeEvent[] = [];
  const trajectory = new ActivityTrajectory((event) => output.push(event));
  trajectory.accept({ type: "thinking-delta", text: "Unfinished" });
  trajectory.dispose();
  expect(kinds(output)).toEqual(["thinking_started", "thinking_started"]);
  expect(kinds(output)).not.toContain("thinking_end");
});

test("a tool call counts as announced, so the response after it announces itself again", () => {
  jest.useFakeTimers();
  const output: AgentRuntimeEvent[] = [];
  const trajectory = new ActivityTrajectory((event) => output.push(event));
  trajectory.accept({ type: "text-delta", text: "Let me check" });
  jest.advanceTimersByTime(350);
  trajectory.accept({ type: "tool-start", id: "1", name: "Bash", input: { command: "ls" } });
  trajectory.accept({ type: "text-delta", text: "Done" });
  expect(
    output.map((event) => (event.type === "activity" ? event.activity.detailKind : event.type)),
  ).toEqual([
    "model_response_started",
    "model_response_started",
    "tool-start",
    "model_response_started",
  ]);
  expect(
    (output[3] as Extract<AgentRuntimeEvent, { type: "activity" }>).activity.entries,
  ).toBeUndefined();
  trajectory.dispose();
});
