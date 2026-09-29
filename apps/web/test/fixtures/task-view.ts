import type { TaskView } from "@lrm/coforge-sdk/internal";

/** A Task of `conversation-1`, made by message `message-<number>`, To do and unowned. */
export const taskView = (number: number, fields: Partial<TaskView> = {}): TaskView => ({
  messageId: `message-${number}`,
  conversationId: "conversation-1",
  number,
  title: `Task ${number}`,
  status: "todo",
  revision: 1,
  owner: null,
  creator: {
    memberId: "member-creator",
    kind: "user",
    id: "user-creator",
    name: "Creator",
    handle: "creator",
  },
  createdAt: "2026-09-25T00:00:00.000Z",
  updatedAt: "2026-09-25T00:00:00.000Z",
  ...fields,
});
