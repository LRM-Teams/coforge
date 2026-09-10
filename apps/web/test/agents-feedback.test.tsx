import "./dom-setup";

import { expect, mock, test } from "bun:test";
import { RouterContextProvider } from "@tanstack/react-router";
import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AgentDetail } from "@/features/agents/agent-detail";
import { AgentDetailPending } from "@/features/agents/agent-detail-pending";
import { AgentsContent } from "@/features/agents/agents-content";
import { getRouter } from "@/router";

const detail = {
  id: "agent-1",
  workspaceId: "workspace-1",
  name: "builder",
  displayName: "Builder",
  description: "Builds the product",
  createdAt: new Date("2026-09-07T00:00:00.000Z"),
  computerId: "computer-1",
  owner: { id: "owner-1", username: "alice" },
  runtimeConfig: {
    runtime: "codex" as const,
    provider: { kind: "default" as const },
    model: "gpt-5",
    modelProvider: "",
    reasoning: "high",
  },
  computer: { id: "computer-1", label: "computer-1" },
  latestError: undefined,
  activity: [],
  status: { value: "active" as const, expiresAt: null, ordering: null },
  ownedByCurrentUser: true,
  runtimeCredential: null,
};

test("Agent detail pending matches the selected tab without inventing status", () => {
  const { rerender } = render(<AgentDetailPending tab="profile" />);
  const page = within(document.body);
  expect(page.getByRole("status").textContent).toBe("Loading Agent details…");
  expect(page.getByRole("main").getAttribute("aria-busy")).toBe("true");
  expect(page.getByRole("region", { name: "Profile" })).toBeTruthy();
  expect(page.queryByText("Online")).toBeNull();
  expect(page.queryByText("Offline")).toBeNull();

  rerender(<AgentDetailPending tab="activity" />);
  expect(page.getByRole("region", { name: "Activity" })).toBeTruthy();
  rerender(<AgentDetailPending tab="reminders" />);
  expect(page.getByRole("region", { name: "Reminders" })).toBeTruthy();
});

test("create submission cannot duplicate or dismiss its draft while saving", async () => {
  const pending = Promise.withResolvers<{ startPublished: boolean }>();
  const onCreate = mock(() => pending.promise);
  render(
    <RouterContextProvider router={getRouter()}>
      <AgentsContent
        agents={[]}
        directory={{ people: [], agents: [] }}
        memberType="all"
        onMemberTypeChange={() => undefined}
        computers={[
          {
            id: "computer-1",
            name: "computer",
            displayName: "Computer",
            runtimes: [{ provider: "codex" }],
          },
        ]}
        defaultCreateDialogOpen
        onCreate={onCreate}
        onLoadRuntimeCatalog={async () => []}
      />
    </RouterContextProvider>,
  );
  const dialog = within(await within(document.body).findByRole("dialog"));
  fireEvent.change(dialog.getByRole("textbox", { name: "Name" }), {
    target: { value: "builder" },
  });
  fireEvent.change(dialog.getByPlaceholderText("What should this Agent help with?"), {
    target: { value: "Build releases" },
  });
  const form = dialog.getByRole("button", { name: "Create agent" }).closest("form")!;
  fireEvent.submit(form);
  fireEvent.submit(form);
  fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));

  expect(onCreate).toHaveBeenCalledTimes(1);
  expect(within(document.body).getByRole("dialog")).toBeTruthy();
  expect(dialog.getByDisplayValue("builder")).toBeTruthy();
  await act(async () => {
    pending.resolve({ startPublished: true });
    await pending.promise;
  });
  await waitFor(() => expect(within(document.body).queryByRole("dialog")).toBeNull());
});

test("edit failure stays inline and preserves the draft", async () => {
  render(
    <RouterContextProvider router={getRouter()}>
      <AgentDetail
        detail={detail}
        tab="profile"
        timeZone="UTC"
        onSaveRuntimeCredential={async () => undefined}
        onDeleteRuntimeCredential={async () => undefined}
        onUpdate={async () => {
          throw new Error("rejected");
        }}
        onLoadRuntimeOptions={async () => ({ providers: ["codex"], catalogs: [] })}
      />
    </RouterContextProvider>,
  );
  fireEvent.click(within(document.body).getByRole("button", { name: "Edit" }));
  const dialog = within(await within(document.body).findByRole("dialog", { name: "Edit Agent" }));
  const name = dialog.getByRole("textbox", { name: "Name" });
  await userEvent.clear(name);
  await userEvent.type(name, "release-builder");
  await userEvent.click(dialog.getByRole("button", { name: "Save runtime config" }));

  expect((await dialog.findByRole("alert")).textContent).toContain("could not be updated");
  expect(dialog.getByDisplayValue("release-builder")).toBeTruthy();
  expect(within(document.body).getAllByRole("alert")).toHaveLength(1);
});

test("updates an Agent with an empty description", async () => {
  const onUpdate = mock(async () => undefined);
  render(
    <RouterContextProvider router={getRouter()}>
      <AgentDetail
        detail={detail}
        tab="profile"
        timeZone="UTC"
        onSaveRuntimeCredential={async () => undefined}
        onDeleteRuntimeCredential={async () => undefined}
        onUpdate={onUpdate}
        onLoadRuntimeOptions={async () => ({ providers: ["codex"], catalogs: [] })}
      />
    </RouterContextProvider>,
  );
  fireEvent.click(within(document.body).getByRole("button", { name: "Edit" }));
  const dialog = within(await within(document.body).findByRole("dialog", { name: "Edit Agent" }));
  const description = dialog.getByRole("textbox", { name: "Description" });
  expect(description.hasAttribute("required")).toBe(false);
  await userEvent.clear(description);
  await userEvent.click(dialog.getByRole("button", { name: "Save runtime config" }));

  await waitFor(() =>
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ description: "" })),
  );
});

test("runtime credential dialog clears its password after cancel and successful save", async () => {
  const onSave = mock(async () => undefined);
  render(
    <RouterContextProvider router={getRouter()}>
      <AgentDetail
        detail={{
          ...detail,
          runtimeConfig: {
            runtime: "coforge" as const,
            provider: { kind: "coforge" as const, providerId: "openai" },
            model: "gpt-5",
            modelProvider: "openai",
            reasoning: "high",
          },
          runtimeCredential: { providerId: "openai", hint: "…abcd" },
        }}
        tab="profile"
        timeZone="UTC"
        onSaveRuntimeCredential={onSave}
        onDeleteRuntimeCredential={async () => undefined}
        onUpdate={async () => undefined}
        onLoadRuntimeOptions={async () => ({ providers: [], catalogs: [] })}
      />
    </RouterContextProvider>,
  );
  const page = within(document.body);
  await userEvent.click(page.getByRole("button", { name: "Edit runtime config" }));
  let dialog = within(await page.findByRole("dialog", { name: "Edit runtime config" }));
  await userEvent.type(
    dialog.getByPlaceholderText("Enter the API key issued by openai"),
    "first-key",
  );
  await userEvent.click(dialog.getByRole("button", { name: "Cancel" }));

  await userEvent.click(page.getByRole("button", { name: "Edit runtime config" }));
  dialog = within(await page.findByRole("dialog", { name: "Edit runtime config" }));
  expect(
    (dialog.getByPlaceholderText("Enter the API key issued by openai") as HTMLInputElement).value,
  ).toBe("");
  await userEvent.type(
    dialog.getByPlaceholderText("Enter the API key issued by openai"),
    "second-key",
  );
  await userEvent.click(dialog.getByRole("button", { name: "Save runtime config" }));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith("second-key"));

  await userEvent.click(page.getByRole("button", { name: "Edit runtime config" }));
  dialog = within(await page.findByRole("dialog", { name: "Edit runtime config" }));
  expect(
    (dialog.getByPlaceholderText("Enter the API key issued by openai") as HTMLInputElement).value,
  ).toBe("");
});
