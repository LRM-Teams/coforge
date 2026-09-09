import "./dom-setup";

import { afterEach, expect, mock, test } from "bun:test";
import { RouterContextProvider } from "@tanstack/react-router";
import { cleanup, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";

import { TaskOverview } from "@/features/tasks/task-overview";
import { getRouter } from "@/router";

afterEach(cleanup);

const tasks = [
  {
    messageId: "message-channel",
    conversationId: "channel-conversation",
    number: 3,
    title: "Prepare channel release",
    status: "in_review" as const,
    revision: 2,
    owner: { memberId: "agent-member", kind: "agent" as const, name: "Release Agent" },
    source: { channelName: "general", agentId: null, label: "#general" },
  },
  {
    messageId: "message-direct",
    conversationId: "direct-conversation",
    number: 3,
    title: "Confirm private rollout",
    status: "todo" as const,
    revision: 1,
    owner: null,
    source: { channelName: null, agentId: "agent-1", label: "Release Helper" },
  },
];

function renderOverview(status?: (typeof tasks)[number]["status"]) {
  const onStatusChange = mock(() => {});
  render(
    <RouterContextProvider router={getRouter()}>
      <TaskOverview tasks={tasks} status={status} onStatusChange={onStatusChange} />
    </RouterContextProvider>,
  );
  return onStatusChange;
}

test("groups tasks by workflow status with counts and retains empty stages", () => {
  renderOverview();
  const page = within(document.body);
  expect(page.queryByRole("button", { name: "Refresh" })).toBeNull();
  const todo = within(page.getByRole("region", { name: "To do" }));
  const review = within(page.getByRole("region", { name: "In review" }));
  expect(todo.getByRole("heading", { name: "To do 1" })).toBeTruthy();
  expect(todo.getByText("Confirm private rollout")).toBeTruthy();
  expect(todo.queryByText("Prepare channel release")).toBeNull();
  expect(review.getByRole("heading", { name: "In review 1" })).toBeTruthy();
  expect(review.getByText("Prepare channel release")).toBeTruthy();
  expect(page.getByRole("heading", { name: "In progress 0" })).toBeTruthy();
  expect(page.getByRole("heading", { name: "Done 0" })).toBeTruthy();
  expect(page.getByRole("heading", { name: "Closed 0" })).toBeTruthy();
});

test("shows conversation-local numbers with source, status, owner, and typed destinations", () => {
  renderOverview();
  const page = within(document.body);

  expect(page.getAllByText("#3")).toHaveLength(2);
  expect(page.getByText("#general")).toBeTruthy();
  expect(page.getByRole("heading", { name: "In review 1" })).toBeTruthy();
  expect(page.getByText(/Owner: Release Agent/)).toBeTruthy();
  expect(page.getByText(/Owner: Unassigned/)).toBeTruthy();
  expect(page.getByRole("link", { name: /Prepare channel release/ }).getAttribute("href")).toBe(
    "/en/messages/channels/channel-conversation?view=tasks",
  );
  expect(page.getByRole("link", { name: /Confirm private rollout/ }).getAttribute("href")).toBe(
    "/en/messages/agent-1?view=tasks",
  );
});

test("filters displayed tasks and reports filter changes", async () => {
  const onStatusChange = renderOverview("todo");
  const page = within(document.body);

  expect(page.getByText("Confirm private rollout")).toBeTruthy();
  expect(page.queryByText("Prepare channel release")).toBeNull();
  expect(page.getAllByRole("region")).toHaveLength(1);
  expect(page.getByRole("region", { name: "To do" })).toBeTruthy();
  const user = userEvent.setup();
  await user.click(page.getByRole("button", { name: /Status/ }));
  await user.click(page.getByRole("option", { name: "Done" }));
  expect(onStatusChange).toHaveBeenCalledWith("done");
  await user.click(page.getByRole("button", { name: /Status/ }));
  await user.click(page.getByRole("option", { name: "All" }));
  expect(onStatusChange).toHaveBeenCalledWith(undefined);
});

test("conflict feedback survives refreshed data removing the last filtered task", async () => {
  function Overview() {
    const [items, setItems] = useState([{ ...tasks[0]!, currentMemberId: "member" }]);
    return (
      <TaskOverview
        tasks={items}
        status="in_review"
        layout="list"
        onStatusChange={() => {}}
        onCommand={async () => {
          setItems([]);
          throw new Error("CONFLICT");
        }}
      />
    );
  }
  render(
    <RouterContextProvider router={getRouter()}>
      <Overview />
    </RouterContextProvider>,
  );
  const page = within(document.body);
  const user = userEvent.setup();
  await user.click(page.getByRole("button", { name: /Change status/ }));
  await user.click(page.getByRole("option", { name: "Done" }));
  expect(page.getByRole("alert").textContent).toContain("could not be updated");
  expect(page.getByText("No tasks match this status")).toBeTruthy();
  expect(page.queryByText("Prepare channel release")).toBeNull();
  expect(page.queryByRole("region")).toBeNull();
});
