import "./dom-setup";

import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TaskBadge, TaskBoard } from "@/features/tasks/task-board";
import { mergeTaskChanges } from "@/features/tasks/use-conversation-tasks";

afterEach(cleanup);

const tasks = [
  {
    messageId: "message-1",
    conversationId: "conversation-1",
    number: 7,
    title: "Review the release candidate without losing the complete original task title",
    status: "todo" as const,
    revision: 2,
    owner: null,
  },
  {
    messageId: "message-2",
    conversationId: "conversation-1",
    number: 8,
    title: "Already underway",
    status: "in_progress" as const,
    revision: 4,
    owner: { memberId: "other", kind: "agent" as const, name: "Release Agent" },
  },
];

test("task board groups tasks and only offers an available task for claiming", async () => {
  const onCommand = mock(async () => {});
  const onOpenMessage = mock(async () => {});
  render(
    <TaskBoard
      tasks={tasks}
      currentMemberId="me"
      canMutate
      onOpenMessage={onOpenMessage}
      onCommand={onCommand}
      onShowChat={() => {}}
    />,
  );
  const page = within(document.body);
  expect(within(page.getByRole("region", { name: "To do" })).getByText("#7")).toBeTruthy();
  expect(
    within(page.getByRole("region", { name: "In progress" })).getByText("Release Agent"),
  ).toBeTruthy();
  expect(page.getAllByRole("button", { name: "Claim" })).toHaveLength(1);
  await userEvent.setup().click(page.getByRole("button", { name: "Claim" }));
  expect(onCommand).toHaveBeenCalledWith({ operation: "claim", number: 7 });
  await userEvent.setup().click(page.getByRole("button", { name: /Review the release/ }));
  expect(onOpenMessage).toHaveBeenCalledWith("message-1");
});

test("read-only task board exposes tasks and threads without mutation controls", () => {
  render(
    <TaskBoard
      tasks={tasks}
      currentMemberId=""
      canMutate={false}
      onOpenMessage={() => {}}
      onCommand={async () => {}}
      onShowChat={() => {}}
      conversationName="#engineering"
    />,
  );
  const page = within(document.body);
  expect(page.getByRole("heading", { name: "#engineering" })).toBeTruthy();
  expect(page.getByText("Already underway")).toBeTruthy();
  expect(page.queryByRole("button", { name: "Claim" })).toBeNull();
  expect(page.queryByRole("button", { name: "Create task" })).toBeNull();
});

test("task board keeps the conversation title, counted tabs, and Chat callback", async () => {
  const onShowChat = mock(() => {});
  render(
    <TaskBoard
      tasks={[]}
      currentMemberId=""
      canMutate={false}
      conversationName="#empty-channel"
      onOpenMessage={() => {}}
      onCommand={async () => {}}
      onShowChat={onShowChat}
    />,
  );
  const page = within(document.body);
  expect(page.getByRole("heading", { name: "#empty-channel" })).toBeTruthy();
  expect(page.getByRole("button", { name: "Tasks 0" }).getAttribute("aria-current")).toBe("page");
  await userEvent.setup().click(page.getByRole("button", { name: "Chat" }));
  expect(onShowChat).toHaveBeenCalledTimes(1);
  expect(page.queryByRole("button", { name: "Create task" })).toBeNull();
  expect(page.queryByRole("button", { name: "Claim" })).toBeNull();
});

test("task layout controls use a third operation row below the primary tabs", () => {
  render(
    <TaskBoard
      tasks={tasks}
      currentMemberId="me"
      canMutate
      conversationName="#engineering"
      onOpenMessage={() => {}}
      onCommand={async () => {}}
      onShowChat={() => {}}
    />,
  );
  const page = within(document.body);
  const tabs = page.getByRole("navigation", { name: "Chat / Tasks" });
  const operations = page.getByRole("toolbar", { name: "Task layout" });
  expect(tabs.parentElement?.nextElementSibling).toBe(operations);
  expect(within(tabs).queryByRole("button", { name: "Board" })).toBeNull();
  expect(within(operations).getByRole("button", { name: "Board" })).toBeTruthy();
  expect(within(operations).getByRole("button", { name: "List" })).toBeTruthy();
});

test("unclaim sends the rendered revision and is hidden for terminal tasks", async () => {
  const onCommand = mock(async () => {});
  render(
    <TaskBoard
      tasks={[
        { ...tasks[1], owner: { ...tasks[1].owner!, memberId: "me" } },
        {
          ...tasks[1],
          messageId: "message-done",
          number: 9,
          status: "done",
          revision: 6,
          owner: { ...tasks[1].owner!, memberId: "me" },
        },
      ]}
      currentMemberId="me"
      canMutate
      onOpenMessage={() => {}}
      onCommand={onCommand}
      onShowChat={() => {}}
    />,
  );
  const buttons = within(document.body).getAllByRole("button", { name: "Unclaim" });
  expect(buttons).toHaveLength(1);
  await userEvent.setup().click(buttons[0]!);
  expect(onCommand).toHaveBeenCalledWith({
    operation: "unclaim",
    number: 8,
    expectedRevision: 4,
  });
});

test("a mutation result updates its task without dropping the rest of the board", () => {
  const changed = { ...tasks[0], status: "in_progress" as const, revision: 3 };
  expect(mergeTaskChanges(tasks, [changed])).toEqual([changed, tasks[1]]);
});

test("task board renders every task returned by the unpaginated backend", () => {
  const manyTasks = Array.from({ length: 51 }, (_, index) => ({
    ...tasks[0],
    messageId: `message-${index}`,
    number: index + 1,
    title: `Task ${index + 1}`,
  }));
  render(
    <TaskBoard
      tasks={manyTasks}
      currentMemberId="me"
      canMutate
      onOpenMessage={() => {}}
      onCommand={async () => {}}
      onShowChat={() => {}}
    />,
  );
  expect(within(document.body).getByText("Task 51")).toBeTruthy();
});

test("create task dialog retries one logical submission with the same request id", async () => {
  const requestIds: string[] = [];
  const onCreateTask = mock(async (_title: string, requestId: string) => {
    requestIds.push(requestId);
    if (requestIds.length === 1) throw new Error("failed");
    return tasks[0];
  });
  render(
    <TaskBoard
      tasks={tasks}
      currentMemberId="me"
      canMutate
      onOpenMessage={() => {}}
      onCommand={async () => {}}
      onShowChat={() => {}}
      onCreateTask={onCreateTask}
    />,
  );
  const user = userEvent.setup();
  await user.click(within(document.body).getByRole("button", { name: "Create task" }));
  const dialog = within(within(document.body).getByRole("dialog"));
  await user.type(dialog.getByRole("textbox", { name: "Title" }), "Ship release");
  await user.click(dialog.getByRole("button", { name: "Create task" }));
  expect(await dialog.findByRole("alert")).toBeTruthy();
  await user.click(dialog.getByRole("button", { name: "Create task" }));
  expect(requestIds).toHaveLength(2);
  expect(requestIds[1]).toBe(requestIds[0]);
});

test("task badge identifies status and owner without implying todo is complete", () => {
  render(<TaskBadge task={tasks[1]} />);
  expect(within(document.body).getByText(/#8 · In progress · Release Agent/)).toBeTruthy();
  expect(document.querySelector("svg")).toBeNull();
});
