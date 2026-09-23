import { expect, test } from "bun:test";

import { announceMemberChanged } from "#src/server/conversations/conversation-realtime.server";

test("a member-change signal that never settles gives up within its budget", async () => {
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (message: string) => warnings.push(message);
  try {
    await announceMemberChanged(
      { memberChanged: () => new Promise<void>(() => {}) },
      { workspaceId: "workspace-1", conversationIds: ["channel-1"] },
      { budgetMs: 10 },
    );
  } finally {
    console.warn = warn;
  }
  expect(warnings.map((line) => JSON.parse(line))).toEqual([
    {
      event: "conversation_realtime:member_changed_failed",
      workspace_id: "workspace-1",
      conversation_count: 1,
      error_type: "TimeoutError",
    },
  ]);
});

test("a write that changed no channel sends no member-change signal", async () => {
  let calls = 0;
  await announceMemberChanged(
    {
      memberChanged: async () => {
        calls += 1;
      },
    },
    { workspaceId: "workspace-1", conversationIds: [] },
  );
  expect(calls).toBe(0);
});
