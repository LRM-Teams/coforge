import { expect, test } from "bun:test";
import type { TaskMember, TaskResult, TaskView } from "@lrm/coforge-sdk/internal";
import { CliError } from "#src/cli-error";
import {
  claimRefusal,
  formatClaimResults,
  formatMyTaskList,
  formatResourceReceiptRecorded,
  formatTaskAmended,
  formatTaskAssigned,
  formatTaskBoard,
  formatTaskConverted,
  formatTaskDeleted,
  formatTaskStatusUpdated,
  formatTaskUnclaimed,
  formatTasksCreated,
} from "#src/task-format";

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

test("A create receipt lists each new Task, the assignment receipt and each thread to follow up in", () => {
  const text = formatTasksCreated("#general", {
    tasks: [
      task(42, {
        title: "Ship it",
        status: "in_progress",
        owner: person("kiro", { kind: "agent" }),
        claimedAt: "2026-09-23T05:00:01.000Z",
        requiresResourceReceipt: true,
      }),
      task(43, { title: "Review it" }),
    ],
    assignmentReceipt: {
      messageId: "9abcdef0-1111-2222-3333-444444444444",
      content: '📌 Assigned @kiro to task #42 "Ship it"',
      assignee: "@kiro",
      state: "started",
    },
  });
  expect(text).toBe(
    [
      "Created 2 task(s) in #general:",
      '#42 [in_progress] assignee=@kiro claimedAt=2026-09-23T05:00:01.000Z msg=42abcdef resource-receipt=pending "Ship it"',
      '#43 [todo] assignee=unassigned claimedAt=null msg=43abcdef "Review it"',
      "",
      "Assignment receipt (msg=9abcdef0):",
      '📌 Assigned @kiro to task #42 "Ship it"',
      "",
      "To follow up in each task's thread:",
      '#42 → coforge message send --target "#general:42abcdef"',
      '#43 → coforge message send --target "#general:43abcdef"',
    ].join("\n"),
  );
});

test("A converted message names its new Task and the thread to follow up in", () => {
  expect(formatTaskConverted("@ada", task(5, { title: "Fix login" }))).toBe(
    [
      'Converted msg=5abcdef0 to task #5 [todo] assignee=unassigned "Fix login"',
      "",
      "To follow up in the task's thread:",
      'coforge message send --target "@ada:5abcdef0"',
    ].join("\n"),
  );
  expect(
    formatTaskConverted("#general", task(6, { owner: person("bob"), status: "in_progress" })),
  ).toStartWith('Converted msg=6abcdef0 to task #6 [in_progress] assignee=@bob "Task 6"');
});

test("Single-Task writes confirm what the server now holds", () => {
  expect(formatTaskUnclaimed(task(4))).toBe("#4 unclaimed — now open.");
  expect(formatTaskAssigned(task(4, { owner: person("ada") }))).toBe("#4 assigned to @ada.");
  expect(formatTaskAssigned(task(4))).toBe("#4 unassigned — now open.");
  expect(formatTaskStatusUpdated(task(4, { status: "in_review" }))).toBe("#4 moved to in_review.");
  expect(formatTaskDeleted(4)).toBe("#4 deleted.");
});

test("An amend receipt shows the new revision, its history event and the current card", () => {
  const amended = task(42, { title: "Ship it (narrowed)", revision: 3, description: "a\nb" });
  const event = {
    id: "event",
    seq: 7,
    actorType: "agent" as const,
    actorName: "kiro",
    createdAt: "2026-09-23T06:00:00.000Z",
    eventType: "amended" as const,
    payload: { changes: { description: { from: null, to: "a\nb" } }, revision: 3 },
  };
  expect(formatTaskAmended({ tasks: [amended], history: [event] })).toBe(
    [
      "#42 amended — revision 3, event seq 7.",
      "title: Ship it (narrowed)",
      "details:",
      "  a",
      "  b",
    ].join("\n"),
  );
  expect(formatTaskAmended({ tasks: [{ ...amended, description: null }], history: [] })).toBe(
    [
      "#42 amended — revision 3; no change recorded.",
      "title: Ship it (narrowed)",
      "details: <none>",
    ].join("\n"),
  );
});

test("A resource receipt names the expiry follow-up and where it is anchored", () => {
  expect(
    formatResourceReceiptRecorded("#general", {
      tasks: [task(7, { requiresResourceReceipt: true })],
      resourceFollowup: {
        id: "0f1e2d3c-1111-2222-3333-444444444444",
        ownerAgentId: "agent",
        owner: "@kiro",
        fireAt: "2030-03-04T05:06:00.000Z",
        messageId: "7abcdef0-1111-2222-3333-444444444444",
        conversationId: "5a5a5a5a-1111-2222-3333-444444444444",
      },
    }),
  ).toBe(
    [
      "Resource receipt recorded for task #7 in #general.",
      "Expiry follow-up 0f1e2d3c owned by @kiro fires 2030-03-04T05:06:00.000Z.",
      "Follow-up anchor: msg=7abcdef0 conversation=5a5a5a5a-1111-2222-3333-444444444444.",
    ].join("\n"),
  );
});

const heldBy = {
  kind: "claim_conflict" as const,
  conflictScope: "implementation_execution" as const,
  blockedActions: ["start_conflicting_execution" as const],
  unblockedActionExamples: ["reply in the task's thread", "read the task's history"],
  currentAssignee: { type: "agent" as const, name: "kiro" },
  taskStatus: "in_progress" as const,
  claimedAt: "2026-09-23T05:00:00.000Z",
  observedAt: "2026-09-23T06:00:00.000Z",
};

test("Claim results mark each selector claimed or refused, and name the holder of a held Task", () => {
  const result: TaskResult = {
    tasks: [task(42)],
    claims: [
      { number: 42, messageId: task(42).messageId, success: true },
      { number: 43, success: false, reason: "already claimed", conflict: heldBy },
      { messageId: "abcd1234", success: false, reason: "message not found" },
    ],
  };
  expect(formatClaimResults("#general", result)).toBe(
    [
      "Claim results (1 claimed, 2 failed):",
      "#42 (msg:42abcdef): claimed",
      "#43: Claim failed — @kiro currently holds the implementation lock (assignment state as of 2026-09-23T06:00:00.000Z).",
      "  Blocked: starting conflicting implementation/change work.",
      "  Not blocked by this claim conflict (each still subject to its own authority/policy): reply in the task's thread · read the task's history.",
      "  This is not a ruling on who owns or leads this lane. If you are its canonical owner or believe it is misrouted, correct the routing in the original thread.",
      "msg:abcd1234: FAILED — message not found. Do not start conflicting execution on this task or take over its scope without a redirect; a failed claim is a concurrency lock, not a ruling on lane ownership.",
      "",
      "Follow up in each task's thread:",
      '#42 → coforge message send --target "#general:42abcdef"',
    ].join("\n"),
  );
  expect(claimRefusal("#general", result)).toBeUndefined();
});

test("A claim that authorises no work is refused with the rows, as a conflict when a Task is held", () => {
  const deletedHolder = {
    ...heldBy,
    currentAssignee: { type: "agent" as const, name: "old-bot", deleted: true },
  };
  const held = claimRefusal("#general", {
    tasks: [],
    claims: [
      { number: 43, success: false, reason: "already claimed", conflict: deletedHolder },
      { number: 44, success: false, reason: "task is closed" },
    ],
  });
  expect(held).toBeInstanceOf(CliError);
  expect(held).toMatchObject({
    code: "CLAIM_CONFLICT",
    message:
      "Claim refused — #43 held by @old-bot [deleted]; #44 task is closed. This is a concurrency lock or refusal, not a tool error and not a ruling on lane ownership.",
    suggestedNextAction:
      "Do not retry the identical claim and do not start conflicting execution. If you are this lane's canonical owner, correct the routing in the original thread.",
  });
  expect(held?.contextText).toStartWith(
    "Claim results (0 claimed, 2 failed):\n#43: Claim failed — @old-bot [deleted] currently holds",
  );
  expect(
    claimRefusal("#general", {
      tasks: [],
      claims: [{ number: 9, success: false, reason: "task not found" }],
    }),
  ).toMatchObject({ code: "CLAIM_FAILED" });
});
