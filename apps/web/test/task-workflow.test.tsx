import "./dom-setup";
import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { renderToString } from "react-dom/server";
import {
  TaskLayoutToggle,
  TaskWorkflow,
  useTaskLayout,
  type TaskLayout,
} from "@/features/tasks/task-workflow";

afterEach(cleanup);

function ResponsiveLayout({ layout }: { layout?: TaskLayout }) {
  return <output>{useTaskLayout(layout)}</output>;
}

test("task layout defaults to mobile list but explicit URL choices win across viewport changes", () => {
  const media = window.matchMedia("(min-width: 768px)");
  const matchMedia = spyOn(window, "matchMedia").mockReturnValue(media);
  Object.defineProperty(media, "matches", { configurable: true, value: false });
  try {
    const container = document.createElement("div");
    container.innerHTML = renderToString(<ResponsiveLayout />);
    expect(container.textContent).toBe("board");
    const onRecoverableError = mock();
    const page = render(<ResponsiveLayout />, { container, hydrate: true, onRecoverableError });
    expect(page.getByRole("status").textContent).toBe("list");
    expect(onRecoverableError).not.toHaveBeenCalled();
    page.rerender(<ResponsiveLayout layout="board" />);
    expect(page.getByRole("status").textContent).toBe("board");
    act(() => {
      Object.defineProperty(media, "matches", { configurable: true, value: true });
      media.dispatchEvent(new Event("change"));
    });
    page.rerender(<ResponsiveLayout layout="list" />);
    expect(page.getByRole("status").textContent).toBe("list");
    page.rerender(<ResponsiveLayout />);
    expect(page.getByRole("status").textContent).toBe("board");
    page.unmount();
  } finally {
    matchMedia.mockRestore();
  }
});

test("drag instructions have stable IDs across independent server renders", () => {
  const workflow = (
    <TaskWorkflow
      tasks={[
        {
          messageId: "task",
          conversationId: "chat",
          number: 1,
          title: "Task",
          status: "todo",
          revision: 1,
          owner: null,
        },
      ]}
      layout="board"
      currentMemberId={() => "me"}
      onMove={async () => {}}
      renderTask={(task, controls) => (
        <article>
          {task.title}
          {controls}
        </article>
      )}
    />
  );
  const first = renderToString(workflow).match(/aria-describedby="([^"]+)"/g);
  const second = renderToString(workflow).match(/aria-describedby="([^"]+)"/g);
  expect(first).not.toBeNull();
  expect(second).toEqual(first);
});

const tasks = [1, 2].map((number) => ({
  messageId: `message-${number}`,
  conversationId: "conversation",
  number,
  title: `Work ${number}`,
  status: "in_progress" as const,
  revision: 7,
  owner: { memberId: "me", kind: "user" as const, name: "Alice" },
}));

function renderWorkflow(onMove = mock(async () => {}), disabled = false) {
  return render(
    <TaskWorkflow
      tasks={tasks}
      layout="list"
      currentMemberId={() => "me"}
      disabled={disabled}
      onMove={onMove}
      renderTask={(task, controls) => (
        <article>
          {task.title}
          {controls}
        </article>
      )}
    />,
  );
}

test("list and board toggle retain status groups and selected state", async () => {
  function Views() {
    const [layout, setLayout] = useState<TaskLayout>("board");
    return (
      <>
        <TaskLayoutToggle layout={layout} onChange={setLayout} />
        <TaskWorkflow
          tasks={tasks}
          layout={layout}
          currentMemberId={() => null}
          onMove={async () => {}}
          renderTask={(task) => task.title}
        />
      </>
    );
  }
  render(<Views />);
  const page = within(document.body);
  await userEvent.setup().click(page.getByRole("radio", { name: "List" }));
  expect(page.getByRole("radio", { name: "List" }).getAttribute("aria-checked")).toBe("true");
  expect(page.getByRole("heading", { name: "In progress 2" })).toBeTruthy();
  expect(page.getByRole("heading", { name: "Done 0" })).toBeTruthy();
  expect(page.queryByRole("button", { name: /Change status/ })).toBeNull();
});

test("status menu submits the rendered revision and locks all movement while saving", async () => {
  let finish!: () => void;
  const onMove = mock(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  renderWorkflow(onMove);
  const page = within(document.body);
  const user = userEvent.setup();
  await user.click(page.getAllByRole("button", { name: /Change status/ })[0]!);
  await user.click(page.getByRole("option", { name: "In review" }));
  expect(onMove).toHaveBeenCalledWith(tasks[0], {
    operation: "update",
    number: 1,
    status: "in_review",
    expectedRevision: 7,
  });
  expect(within(page.getByRole("region", { name: "In review" })).getByText("Work 1")).toBeTruthy();
  expect(page.getByRole("heading", { name: "In progress 1" })).toBeTruthy();
  for (const control of page.getAllByRole("button", { name: /Change status/ }))
    expect(control.hasAttribute("data-disabled")).toBe(true);
  await act(async () => finish());
});

test("failed status writes keep original group and report the error", async () => {
  renderWorkflow(
    mock(async () => {
      throw new Error("CONFLICT");
    }),
  );
  const page = within(document.body);
  const user = userEvent.setup();
  await user.click(page.getAllByRole("button", { name: /Change status/ })[0]!);
  await user.click(page.getByRole("option", { name: "Done" }));
  expect(page.getByRole("alert").textContent).toContain("could not be updated");
  expect(page.getByRole("heading", { name: "In progress 2" })).toBeTruthy();
  expect(page.getByRole("heading", { name: "Done 0" })).toBeTruthy();
});

test("read-only views expose neither status controls nor drag handles", () => {
  renderWorkflow(undefined, true);
  const page = within(document.body);
  expect(page.queryByRole("button", { name: /Change status/ })).toBeNull();
  expect(page.queryByRole("button", { name: /Move task/ })).toBeNull();
});

test("failed optimistic move restores latest server data rather than the old snapshot", async () => {
  let fail!: (cause: Error) => void;
  const onMove = mock(
    () =>
      new Promise<void>((_resolve, reject) => {
        fail = reject;
      }),
  );
  const view = renderWorkflow(onMove);
  const page = within(document.body);
  const user = userEvent.setup();
  await user.click(page.getAllByRole("button", { name: /Change status/ })[0]!);
  await user.click(page.getByRole("option", { name: "In review" }));
  expect(within(page.getByRole("region", { name: "In review" })).getByText("Work 1")).toBeTruthy();
  view.rerender(
    <TaskWorkflow
      tasks={[{ ...tasks[0]!, status: "closed", revision: 8 }, tasks[1]!]}
      layout="list"
      currentMemberId={() => "me"}
      onMove={onMove}
      renderTask={(task, controls) => (
        <article>
          {task.title}
          {controls}
        </article>
      )}
    />,
  );
  await act(async () => fail(new Error("CONFLICT")));
  expect(within(page.getByRole("region", { name: "Closed" })).getByText("Work 1")).toBeTruthy();
  expect(page.getByRole("heading", { name: "In review 0" })).toBeTruthy();
  expect(page.getByRole("heading", { name: "In progress 1" })).toBeTruthy();
  expect(page.getByRole("alert").textContent).toContain("could not be updated");
});
