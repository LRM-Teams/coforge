import "./dom-setup";

import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AgentRuntimeFields } from "@/features/agents/agent-runtime-fields";

afterEach(cleanup);

const model = {
  id: "gpt-5",
  displayName: "GPT 5",
  description: "",
  modelProvider: "openai",
  reasoningEfforts: ["low", "high"],
  defaultReasoning: "low",
  recommended: true,
};

test("loads on demand and only offers installed or currently configured runtimes", async () => {
  const user = userEvent.setup();
  const load = mock(async () => ({
    providers: ["codex"],
    catalogs: [{ provider: "codex", models: [model] }],
  }));
  const view = render(<AgentRuntimeFields open={false} computerId="computer-1" onLoad={load} />);
  expect(load).toHaveBeenCalledTimes(0);

  view.rerender(<AgentRuntimeFields open computerId="computer-1" onLoad={load} />);
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  await user.click(within(document.body).getByRole("combobox", { name: "Runtime provider" }));
  expect(within(document.body).getByText("Codex")).toBeTruthy();
  expect(within(document.body).queryByText("Claude Code")).toBeNull();
});

test("replays the current catalog model and reasoning and submits no computer id", async () => {
  let submitted: FormData | undefined;
  render(
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submitted = new FormData(event.currentTarget);
      }}
    >
      <AgentRuntimeFields
        open
        computerId="computer-1"
        initial={{
          provider: "coforge",
          modelProvider: "openai",
          model: "gpt-5",
          reasoning: "high",
        }}
        onLoad={async () => ({
          providers: [],
          catalogs: [{ provider: "coforge", models: [model] }],
        })}
      />
      <button type="submit">Save</button>
    </form>,
  );
  await waitFor(() => expect(document.body.textContent).toContain("openai / GPT 5"));
  expect(document.body.textContent).toContain("high");
  fireEvent.click(within(document.body).getByRole("button", { name: "Save" }));
  expect(Object.fromEntries(submitted!)).toEqual({
    provider: "coforge",
    modelProvider: "openai",
    model: "gpt-5",
    reasoning: "high",
  });
});

test("keeps a configured model visible when it is absent from the latest catalog", async () => {
  let submitted: FormData | undefined;
  render(
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submitted = new FormData(event.currentTarget);
      }}
    >
      <AgentRuntimeFields
        open
        computerId="computer-1"
        initial={{
          provider: "pi",
          modelProvider: "legacy-provider",
          model: "legacy-model",
          reasoning: "balanced",
        }}
        onLoad={async () => ({ providers: ["pi"], catalogs: [] })}
      />
      <button type="submit">Save</button>
    </form>,
  );

  await waitFor(() =>
    expect(
      within(document.body).getByRole("combobox", { name: /Model Optional/ }).textContent,
    ).toContain("legacy-provider / legacy-model"),
  );
  fireEvent.click(within(document.body).getByRole("button", { name: "Save" }));
  expect(Object.fromEntries(submitted!)).toMatchObject({
    provider: "pi",
    modelProvider: "legacy-provider",
    model: "legacy-model",
    reasoning: "balanced",
  });
});

test("submits the model provider selected through an external runtime catalog", async () => {
  let submitted: FormData | undefined;
  const user = userEvent.setup();
  const load = mock(async () => ({
    providers: ["pi"],
    catalogs: [{ provider: "pi", models: [model] }],
  }));
  render(
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submitted = new FormData(event.currentTarget);
      }}
    >
      <AgentRuntimeFields
        open
        computerId="computer-1"
        initial={{ provider: "pi", modelProvider: "", model: "", reasoning: "" }}
        onLoad={load}
      />
      <button type="submit">Save</button>
    </form>,
  );
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1));

  await user.click(within(document.body).getByRole("combobox", { name: /Model Optional/ }));
  await user.click(within(document.body).getByRole("option", { name: "openai / GPT 5" }));
  await waitFor(() =>
    expect(
      within(document.body).getByRole("combobox", { name: /Model Optional/ }).textContent,
    ).toContain("openai / GPT 5"),
  );
  await user.click(within(document.body).getByRole("button", { name: "Save" }));

  expect(Object.fromEntries(submitted!)).toMatchObject({
    provider: "pi",
    modelProvider: "openai",
    model: "gpt-5",
  });
});

test("reloads runtime options when the selected Computer changes", async () => {
  const load = mock(async (computerId: string) => ({
    providers: computerId === "computer-1" ? ["codex"] : ["claude-code"],
    catalogs: [],
  }));
  const view = render(<AgentRuntimeFields open computerId="computer-1" onLoad={load} />);
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1));

  view.rerender(<AgentRuntimeFields open computerId="computer-2" onLoad={load} />);
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
});

test("falls back to manual provider and model inputs and allows retry", async () => {
  const load = mock(async () => {
    throw new Error("offline");
  });
  render(<AgentRuntimeFields open computerId="computer-1" onLoad={load} />);

  await waitFor(() => expect(within(document.body).getByRole("alert")).toBeTruthy());
  expect(within(document.body).getByRole("textbox", { name: "Model provider" })).toBeTruthy();
  expect(within(document.body).getByRole("textbox", { name: "Model" })).toBeTruthy();
  fireEvent.click(within(document.body).getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
});
