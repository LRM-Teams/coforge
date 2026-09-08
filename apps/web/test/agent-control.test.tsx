import "./dom-setup";

import { expect, mock, test } from "bun:test";
import { render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentControl } from "@/features/agents/agent-control";

test("controls submit immediately without loading state, disabling buttons or showing progress", async () => {
  const submitted = Promise.withResolvers<void>();
  const execute = mock(() => submitted.promise);
  render(<AgentControl agentId="agent-1" agentName="Dax" onExecute={execute} />);
  const page = within(document.body);
  try {
    await userEvent.click(page.getByRole("button", { name: "Restart" }));
    const dialog = within(await page.findByRole("dialog", { name: "Restart Dax" }));
    await userEvent.click(
      dialog.getByRole("button", { name: "Reset session & restart", pressed: false }),
    );
    expect(execute).not.toHaveBeenCalled();
    await userEvent.click(
      dialog
        .getAllByRole("button", { name: "Reset session & restart" })
        .find((button) => !button.hasAttribute("aria-pressed"))!,
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toMatchObject({
      agentId: "agent-1",
      action: "reset-session",
    });
    for (const button of page.getAllByRole<HTMLButtonElement>("button"))
      expect(button.disabled).toBe(false);
    expect(page.queryByRole("status")).toBeNull();
    expect(page.queryByRole("dialog")).toBeNull();
    expect(page.queryByRole("button", { name: "Check status" })).toBeNull();
    expect(page.queryByRole("button", { name: "Retry operation" })).toBeNull();
  } finally {
    submitted.resolve();
    await submitted.promise;
  }
});

test("full reset requires destructive confirmation, and cancel does not submit", async () => {
  const execute = mock(async () => {});
  render(<AgentControl agentId="agent-1" agentName="Dax" onExecute={execute} />);
  const page = within(document.body);
  await userEvent.click(page.getByRole("button", { name: "Restart" }));
  const dialog = await page.findByRole("dialog");
  expect(within(dialog).queryByRole("alert")).toBeNull();
  await userEvent.click(
    within(dialog).getByRole("button", { name: "Full reset & restart", pressed: false }),
  );
  expect(dialog.textContent).toContain("all files in this Agent workspace");
  expect(dialog.textContent).toContain("Workspace Skills");
  expect(dialog.textContent).toContain("irreversible");
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(execute).not.toHaveBeenCalled();
  await userEvent.click(page.getByRole("button", { name: "Restart" }));
  const reopened = within(await page.findByRole("dialog"));
  expect(reopened.getByRole("button", { name: "Restart", pressed: true })).toBeTruthy();
  await userEvent.click(
    reopened.getByRole("button", { name: "Full reset & restart", pressed: false }),
  );
  await userEvent.click(
    reopened
      .getAllByRole("button", { name: "Full reset & restart" })
      .find((button) => !button.hasAttribute("aria-pressed"))!,
  );
  expect(execute).toHaveBeenCalledTimes(1);
  expect(execute.mock.calls[0]![0]).toMatchObject({ action: "full-reset", confirmed: true });
});

test("a rejected control request gives failure feedback without a progress panel", async () => {
  render(
    <AgentControl
      agentId="agent-1"
      agentName="Dax"
      onExecute={async () => {
        throw new Error("offline");
      }}
    />,
  );
  const page = within(document.body);
  await userEvent.click(page.getByRole("button", { name: "Restart" }));
  await userEvent.click(
    within(await page.findByRole("dialog"))
      .getAllByRole("button", { name: "Restart" })
      .find((button) => !button.hasAttribute("aria-pressed"))!,
  );
  expect((await page.findByRole("alert")).textContent).toContain("could not be confirmed");
  expect(page.queryByRole("status")).toBeNull();
  expect(page.getByRole<HTMLButtonElement>("button", { name: "Restart" }).disabled).toBe(false);
});
