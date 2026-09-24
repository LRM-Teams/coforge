import { expect, test } from "bun:test";
import type { TaskMember, TaskResult, TaskView } from "@lrm/coforge-sdk/internal";
import { formatMyTaskList, formatTaskBoard } from "#src/task-format";

const person = (handle: string, fields: Partial<TaskMember> = {}): TaskMember => ({
  memberId: `member-${handle}`,
  kind: "user",
  id: `user-${handle}`,
  name: handle,
  handle,
  ...fields,
});

const task = (number: number, fields: Partial<TaskView> = {}): TaskView => ({
  messageId: `${number}abcdef0-1111-2222-3333-444444444444`,
  conversationId: "conversation",
  number,
  title: `Task ${number}`,
  status: "todo",
  revision: 1,
  owner: null,
  creator: person("ada"),
  createdAt: "2026-09-23T05:00:00.000Z",
  updatedAt: "2026-09-23T06:30:15.000Z",
  requiresResourceReceipt: false,
  resourceReceiptRecordedAt: null,
  ...fields,
});

const coverage: TaskResult["coverage"] = {
  status: "incomplete",
  visibleConversationKinds: ["channel", "dm"],
  includesArchived: true,
  inaccessibleScope: "not_asserted",
  reason: "Reads the channels and DMs this Agent is a member of now.",
};

test("A conversation's board lists each Task with its owner, creator, receipt and times", () => {
  const text = formatTaskBoard(
    "#general",
    {
      tasks: [
        task(3, {
          title: "Fix login",
          status: "in_progress",
          revision: 4,
          owner: person("kiro", { kind: "agent", deleted: true }),
          requiresResourceReceipt: true,
          description: "Reproduce first.\nThen patch.",
        }),
        task(4, {
          creator: person("bob", { left: true }),
          requiresResourceReceipt: true,
          resourceReceiptRecordedAt: "2026-09-23T07:00:00.000Z",
        }),
      ],
    },
    undefined,
  );
  expect(text).toBe(
    [
      "## Task Board for #general (2 tasks)",
      "",
      "#3 [in_progress] Fix login → @kiro [deleted] (by @ada) msg=3abcdef0 rev=4 resource-receipt=pending created=2026-09-23 05:00:00Z updated=2026-09-23 06:30:15Z",
      "  details: Reproduce first.",
      "           Then patch.",
      "#4 [todo] Task 4 (by @bob [left]) msg=4abcdef0 rev=1 resource-receipt=recorded created=2026-09-23 05:00:00Z updated=2026-09-23 06:30:15Z",
    ].join("\n"),
  );
});

test("An empty board names the status it was filtered by", () => {
  expect(formatTaskBoard("@ada", { tasks: [] }, undefined)).toBe("No tasks in @ada.");
  expect(formatTaskBoard("#general", { tasks: [] }, "all")).toBe("No tasks in #general.");
  expect(formatTaskBoard("#general", { tasks: [] }, "in_review")).toBe(
    "No in_review tasks in #general.",
  );
});

test("An Agent's own list groups its Tasks by status and states the coverage it was given", () => {
  const text = formatMyTaskList(
    {
      tasks: [
        task(7, { status: "in_progress", channelRef: "#general", title: "Ship\n  the   fix" }),
        task(2, {
          channelRef: "@ada",
          creator: person("kiro", { kind: "agent", deleted: true }),
          requiresResourceReceipt: true,
        }),
        task(9, {
          status: "in_progress",
          channelRef: "#ops",
          creator: person("bob", { left: true }),
        }),
      ],
      coverage,
      pagination: { mode: "complete", truncated: false },
    },
    undefined,
  );
  expect(text).toBe(
    [
      "## My assigned tasks in this Workspace (unfinished)",
      "",
      "Coverage: incomplete · visible kinds=channel|dm · archived=included · inaccessible scope=not_asserted",
      "Output: showing 3 of 3 visible matches · mode=complete · truncated=false",
      "",
      "### todo (1)",
      "- @ada task #2 [todo] by=@kiro creator=deleted msg=2abcdef0 resource-receipt=pending created=2026-09-23 05:00:00Z updated=2026-09-23 06:30:15Z Task 2",
      "### in_progress (2)",
      "- #general task #7 [in_progress] by=@ada msg=7abcdef0 created=2026-09-23 05:00:00Z updated=2026-09-23 06:30:15Z Ship the fix",
      "- #ops task #9 [in_progress] by=@bob creator=left msg=9abcdef0 created=2026-09-23 05:00:00Z updated=2026-09-23 06:30:15Z Task 9",
    ].join("\n"),
  );
});

test("An empty own list still states its coverage, and a missing field reads unknown", () => {
  expect(
    formatMyTaskList(
      {
        tasks: [],
        coverage: { ...coverage, includesArchived: false },
        pagination: { mode: "complete", truncated: false },
      },
      "done",
    ),
  ).toBe(
    [
      "## My assigned tasks in this Workspace (status=done)",
      "",
      "Coverage: incomplete · visible kinds=channel|dm · archived=not included · inaccessible scope=not_asserted",
      "Output: showing 0 of 0 visible matches · mode=complete · truncated=false",
      "",
      "No tasks matched in the covered visible scope.",
    ].join("\n"),
  );
  expect(formatMyTaskList({ tasks: [] }, "all").split("\n").slice(0, 4)).toEqual([
    "## My assigned tasks in this Workspace (status=all)",
    "",
    "Coverage: unknown · visible kinds=unknown · archived=unknown · inaccessible scope=unknown",
    "Output: showing 0 of 0 visible matches · mode=unknown · truncated=unknown",
  ]);
});
