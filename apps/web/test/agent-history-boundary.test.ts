import { expect, test } from "bun:test";
import { agentHistoryModelSeenBoundary } from "#src/server/agents/agent-history-boundary.server";

// Raft 1.0.38's `model_seen_up_to_seq`: a history page moves the Agent's contiguous boundary to its
// newest message only when the page joins what the Agent had already read (its read-through).
const page = { readThrough: 10, minSequence: 8, maxSequence: 14, hasOlder: true } as const;

test("an unanchored read starts right after the read-through, so it reaches its newest message", () => {
  expect(agentHistoryModelSeenBoundary({ ...page, minSequence: 11 })).toBe(14);
  // An explicit window is not a read of what is unread, wherever it starts.
  expect(agentHistoryModelSeenBoundary({ ...page, minSequence: 12, fromSequence: 12 })).toBeNull();
  expect(agentHistoryModelSeenBoundary({ ...page, minSequence: 11, fromSequence: 11 })).toBeNull();
  expect(agentHistoryModelSeenBoundary({ ...page, minSequence: 1, fromSequence: 1 })).toBeNull();
});

test("an anchored page with a window start never joins, so it cannot move the read-through", () => {
  // `before=X&fromSequence=50` with the read-through at 10: messages 11–49 were never shown.
  expect(
    agentHistoryModelSeenBoundary({
      ...page,
      anchor: "before",
      anchorSequence: 60,
      fromSequence: 50,
      minSequence: 50,
      maxSequence: 59,
      hasOlder: false,
    }),
  ).toBeNull();
  expect(
    agentHistoryModelSeenBoundary({
      ...page,
      anchor: "after",
      anchorSequence: 9,
      fromSequence: 50,
    }),
  ).toBeNull();
});

test("an older or newer page joins only when it overlaps the read-through or starts at the beginning", () => {
  expect(agentHistoryModelSeenBoundary({ ...page, anchor: "after", anchorSequence: 9 })).toBe(14);
  expect(
    agentHistoryModelSeenBoundary({ ...page, anchor: "after", anchorSequence: 12 }),
  ).toBeNull();
  expect(agentHistoryModelSeenBoundary({ ...page, anchor: "before", anchorSequence: 15 })).toBe(14);
  expect(
    agentHistoryModelSeenBoundary({
      ...page,
      anchor: "before",
      anchorSequence: 30,
      minSequence: 20,
      maxSequence: 29,
    }),
  ).toBeNull();
  expect(
    agentHistoryModelSeenBoundary({
      ...page,
      anchor: "before",
      anchorSequence: 30,
      minSequence: 20,
      maxSequence: 29,
      hasOlder: false,
    }),
  ).toBe(29);
});

test("an anchored around read and an empty page state no boundary", () => {
  expect(
    agentHistoryModelSeenBoundary({ ...page, anchor: "around", anchorSequence: 11 }),
  ).toBeNull();
  expect(
    agentHistoryModelSeenBoundary({
      readThrough: 10,
      hasOlder: false,
      minSequence: undefined,
      maxSequence: undefined,
    }),
  ).toBeNull();
});
