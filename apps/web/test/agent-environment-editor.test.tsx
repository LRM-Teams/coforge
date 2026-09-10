import "./dom-setup";
import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentEnvironmentEditor } from "@/features/agents/agent-environment-editor";

afterEach(cleanup);

test("loads only explicit overrides on demand, saves exact values and reloads persisted settings", async () => {
  let saved = { HTTPS_PROXY: "http://custom.example:8080" };
  const load = mock(async () => saved);
  const save = mock(async (env: Record<string, string>) => {
    saved = env as typeof saved;
    return { restart: "published" as const };
  });
  const view = render(<AgentEnvironmentEditor onLoad={load} onSave={save} />);
  const page = within(view.container);
  expect(load).not.toHaveBeenCalled();
  fireEvent.click(page.getByRole("button", { name: "Edit environment" }));
  await page.findByDisplayValue("http://custom.example:8080");
  await userEvent.clear(page.getByLabelText("Value 1"));
  await userEvent.type(page.getByLabelText("Value 1"), "  exact value  ");
  fireEvent.click(page.getByRole("button", { name: "Save and restart" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith({ HTTPS_PROXY: "  exact value  " }));
  await page.findByText("Environment saved. Restart requested.");
  fireEvent.click(page.getByRole("button", { name: "Edit environment" }));
  expect((await page.findByLabelText<HTMLInputElement>("Value 1")).value).toBe("  exact value  ");
  expect(load).toHaveBeenCalledTimes(2);
});

test("failed reads cannot be saved as empty overrides", async () => {
  const save = mock(async () => ({ restart: "published" as const }));
  const view = render(
    <AgentEnvironmentEditor
      onLoad={async () => {
        throw new Error("offline");
      }}
      onSave={save}
    />,
  );
  const page = within(view.container);
  fireEvent.click(page.getByRole("button", { name: "Edit environment" }));
  await page.findByRole("alert");
  expect(page.queryByRole("button", { name: "Save and restart" })).toBeNull();
  expect(save).not.toHaveBeenCalled();
});
