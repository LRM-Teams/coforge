import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { TaskCommand, TaskView } from "@lrm/coforge-sdk/internal";

import {
  createTaskOverview,
  taskOverviewQuery,
  type TaskOverviewApi,
} from "#src/features/tasks/task-overview-collection";

/**
 * The Tasks page's rows and the changes made there, against fake server calls: a move shows at
 * once and then takes the server's copy of the Task; a change with nothing to show first is still
 * saved; a refused change puts the row back.
 */
const task = (number: number, fields: Partial<TaskView> = {}): TaskView => ({
  messageId: `message-${number}`,
  conversationId: "conversation-1",
  number,
  title: `Task ${number}`,
  status: "todo",
  revision: 1,
  owner: null,
  ...fields,
});
const viewer = {
  memberId: "member-me",
  kind: "user" as const,
  id: "user-me",
  name: "Me",
  handle: "me",
};

async function overviewWith(execute: TaskOverviewApi["execute"]) {
  const commands: TaskCommand[] = [];
  const api: TaskOverviewApi = {
    load: async () => ({
      tasks: [task(1), task(2, { status: "in_progress", owner: viewer })].map((view) => ({
        ...view,
        currentMemberId: "member-me",
        source: { channelName: "product", agentId: null, label: "#product" },
        project: { id: "project-1", name: "Launch", slug: "launch" },
      })),
    }),
    execute: async (command) => {
      commands.push(command);
      return execute(command);
    },
  };
  // As the app's client: data read within 30 s is fresh, so mounting does not re-read it.
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000 } } });
  await queryClient.query(taskOverviewQuery("w", api));
  const overview = createTaskOverview(queryClient, "w", api);
  await overview.tasks.preload();
  return { overview, commands };
}

test("a move shows at once, then takes the server's copy of the Task", async () => {
  const { overview, commands } = await overviewWith(async () => ({
    tasks: [task(1, { status: "in_progress", owner: viewer, revision: 2 })],
  }));
  const row = overview.tasks.get("message-1")!;
  const saved = overview.run(row, { operation: "claim", number: 1 });
  expect(overview.tasks.get("message-1")?.status).toBe("in_progress");
  await saved;
  expect(commands.map((command) => [command.operation, command.conversationId])).toEqual([
    ["claim", "conversation-1"],
  ]);
  // The server's owner and revision; the page's own fields (source, Project) stay.
  expect(overview.tasks.get("message-1")).toMatchObject({
    status: "in_progress",
    revision: 2,
    owner: viewer,
    project: { id: "project-1" },
  });
});

test("a change with nothing to show first is still saved and takes the server's copy", async () => {
  const { overview, commands } = await overviewWith(async () => ({
    tasks: [task(2, { status: "in_progress", owner: null, revision: 2 })],
  }));
  await overview.run(overview.tasks.get("message-2")!, { operation: "unassign", number: 2 });
  expect(commands.map((command) => command.operation)).toEqual(["unassign"]);
  expect(overview.tasks.get("message-2")?.owner).toBeNull();
});

test("a refused move puts the row back and rejects", async () => {
  const { overview } = await overviewWith(async () => {
    throw new Error("TASK_CONFLICT");
  });
  const saved = overview.run(overview.tasks.get("message-2")!, {
    operation: "update",
    number: 2,
    status: "done",
    expectedRevision: 1,
  });
  await expect(saved).rejects.toThrow("TASK_CONFLICT");
  expect(overview.tasks.get("message-2")?.status).toBe("in_progress");
});

test("a move of a Task the page no longer lists is still saved", async () => {
  const { overview, commands } = await overviewWith(async () => ({ tasks: [] }));
  const gone = { ...overview.tasks.get("message-1")!, messageId: "message-gone", number: 9 };
  await overview.run(gone, { operation: "claim", number: 9 });
  expect(commands.map((command) => command.operation)).toEqual(["claim"]);
});
