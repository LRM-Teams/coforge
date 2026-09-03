import "./dom-setup";

import { expect, mock, test } from "bun:test";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { WorkspaceSwitcher } from "@/features/workspaces/workspace-switcher";

const workspaces = [
  { id: "ws-1", slug: "lrm-team", name: "LRM-Team" },
  { id: "ws-2", slug: "test-team", name: "Test-Team" },
];

test("the workspace switcher lists memberships and can create a Workspace", async () => {
  const user = userEvent.setup({ document });
  const onSelect = mock(async () => {});
  const onCreate = mock(async () => {});
  render(
    <WorkspaceSwitcher
      workspaces={workspaces}
      current={workspaces[0]!}
      onSelect={onSelect}
      onCreate={onCreate}
    />,
  );
  const page = within(document.body);
  await user.click(page.getByRole("button", { name: "Current workspace" }));
  expect(page.getByText("Workspaces")).toBeTruthy();
  expect(page.getByRole("menuitem", { name: /LRM-Team/ })).toBeTruthy();
  await user.click(page.getByRole("menuitem", { name: /Test-Team/ }));
  await waitFor(() => expect(onSelect).toHaveBeenCalledWith("test-team"));
  await user.click(page.getByRole("button", { name: "Current workspace" }));
  await user.click(page.getByRole("menuitem", { name: "Create workspace" }));
  await user.type(page.getByLabelText("Workspace name"), "Research");
  expect((page.getByLabelText("Workspace URL") as HTMLInputElement).value).toBe("research");
  await user.click(page.getByRole("button", { name: "Create workspace" }));
  await waitFor(() =>
    expect(onCreate).toHaveBeenCalledWith({ name: "Research", slug: "research" }),
  );
  cleanup();
});
