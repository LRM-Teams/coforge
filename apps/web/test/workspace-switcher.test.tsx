import "./dom-setup";

import { expect, mock, test } from "bun:test";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AppToastProvider } from "@/components/ui/toast";
import { WorkspaceSwitcher } from "@/features/workspaces/workspace-switcher";
import { AppError } from "@/lib/app-error";
import { overwriteGetLocale } from "@/paraglide/runtime";

const workspaces = [
  { id: "ws-1", slug: "lrm-team", name: "LRM-Team" },
  { id: "ws-2", slug: "test-team", name: "Test-Team" },
];

test("the workspace switcher lists memberships and can create a Workspace", async () => {
  const user = userEvent.setup({ document });
  const onSelect = mock(async () => {});
  const onCreate = mock(async () => {});
  render(
    <AppToastProvider>
      <WorkspaceSwitcher
        workspaces={workspaces}
        current={workspaces[0]!}
        onSelect={onSelect}
        onCreate={onCreate}
      />
    </AppToastProvider>,
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

test("workspace action failures use safe localized feedback", async () => {
  const user = userEvent.setup({ document });
  render(
    <AppToastProvider>
      <WorkspaceSwitcher
        workspaces={workspaces}
        current={workspaces[0]!}
        onSelect={async () => {
          throw new Error("Can't reach database at 127.0.0.1");
        }}
        onCreate={async () => {
          throw new AppError("CONFLICT");
        }}
      />
    </AppToastProvider>,
  );
  const page = within(document.body);
  await user.click(page.getByRole("button", { name: "Current workspace" }));
  await user.click(page.getByRole("menuitem", { name: /Test-Team/ }));
  await waitFor(() =>
    expect(page.getByRole("region", { name: "Notifications" }).textContent).toContain(
      "The workspace could not be selected. Try again.",
    ),
  );

  await user.click(page.getByRole("button", { name: "Current workspace" }));
  await user.click(page.getByRole("menuitem", { name: "Create workspace" }));
  await user.type(page.getByLabelText("Workspace name"), "Research");
  await user.click(page.getByRole("button", { name: "Create workspace" }));
  await waitFor(() =>
    expect(page.getByRole("alert").textContent).toContain("That workspace URL is already taken."),
  );
  expect(document.body.textContent).not.toContain("127.0.0.1");
  cleanup();
});

test("toast viewport and workspace failure use the Simplified Chinese catalog", async () => {
  overwriteGetLocale(() => "zh-CN");
  const user = userEvent.setup({ document });
  render(
    <AppToastProvider>
      <WorkspaceSwitcher
        workspaces={workspaces}
        current={workspaces[0]!}
        onSelect={async () => {
          throw new Error("database secret");
        }}
      />
    </AppToastProvider>,
  );
  const page = within(document.body);
  await user.click(page.getByRole("button", { name: "当前工作区" }));
  await user.click(page.getByRole("menuitem", { name: /Test-Team/ }));
  await waitFor(() =>
    expect(page.getByRole("region", { name: "消息" }).textContent).toContain(
      "无法选择工作区，请重试。",
    ),
  );
  expect(document.body.textContent).not.toContain("secret");
  cleanup();
  overwriteGetLocale(() => "en");
});
