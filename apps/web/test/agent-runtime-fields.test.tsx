import "./dom-setup";

import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Button } from "@/components/base/buttons/button";
import { AgentRuntimeFields } from "@/features/agents/agent-runtime-fields";

afterEach(cleanup);

// The official Select's accessible name is "<value> <label> *" (the trailing "*" always
// renders in this DOM environment, which has no stylesheet to hide it when not required), so
// tests match on a name that contains "Model" but not "Model provider" rather than an exact
// or prefixed string.
const isModelSelect = (name: string) => /\bModel\b/.test(name) && !/Model provider/.test(name);

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
  await user.click(within(document.body).getByRole("button", { name: /Runtime provider/ }));
  expect(within(document.body).getByRole("option", { name: "Codex" })).toBeTruthy();
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
        credentialConfigured
        onLoad={async () => ({
          providers: [],
          catalogs: [{ provider: "coforge", models: [model] }],
        })}
      />
      <Button type="submit">Save</Button>
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
    apiKey: "",
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
      <Button type="submit">Save</Button>
    </form>,
  );

  await waitFor(() =>
    expect(
      within(document.body).getByRole("button", { name: isModelSelect }).textContent,
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
        initial={{
          provider: "pi",
          modelProvider: "",
          model: "",
          reasoning: "",
        }}
        onLoad={load}
      />
      <Button type="submit">Save</Button>
    </form>,
  );
  await waitFor(() => expect(load).toHaveBeenCalledTimes(1));

  await user.click(within(document.body).getByRole("button", { name: isModelSelect }));
  await user.click(within(document.body).getByRole("option", { name: "openai / GPT 5" }));
  await waitFor(() =>
    expect(
      within(document.body).getByRole("button", { name: isModelSelect }).textContent,
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
  expect(
    within(document.body).getByRole("textbox", {
      name: (name: string) => name.startsWith("Model provider"),
    }),
  ).toBeTruthy();
  expect(
    within(document.body).getByRole("textbox", {
      name: (name: string) => name.startsWith("Model") && !name.startsWith("Model provider"),
    }),
  ).toBeTruthy();
  fireEvent.click(within(document.body).getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
});

test("Pi offers CoForge catalog providers and submits an optional isolated API key", async () => {
  let submitted: FormData | undefined;
  const user = userEvent.setup();
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
        onLoad={async () => ({
          providers: ["pi"],
          catalogs: [
            {
              provider: "pi",
              models: [{ ...model, id: "local", displayName: "Local", modelProvider: "" }],
            },
            { provider: "coforge", models: [model] },
          ],
        })}
      />
      <Button type="submit">Save</Button>
    </form>,
  );
  await waitFor(() =>
    expect(within(document.body).getByRole("button", { name: /Model provider/ })).toBeTruthy(),
  );
  await user.click(within(document.body).getByRole("button", { name: isModelSelect }));
  await user.click(within(document.body).getByRole("option", { name: "openai / GPT 5" }));
  const key = within(document.body).getByLabelText("openai API key");
  expect(key.hasAttribute("required")).toBe(false);
  await user.type(key, "secret-key");
  await user.click(within(document.body).getByRole("button", { name: "Save" }));
  expect(Object.fromEntries(submitted!)).toMatchObject({
    provider: "pi",
    modelProvider: "openai",
    model: "gpt-5",
    apiKey: "secret-key",
  });
});

test("clears a drafted API key when model provider changes", async () => {
  const user = userEvent.setup();
  render(
    <AgentRuntimeFields
      open
      computerId="computer-1"
      onLoad={async () => ({
        providers: [],
        catalogs: [
          {
            provider: "coforge",
            models: [model, { ...model, id: "claude", modelProvider: "anthropic" }],
          },
        ],
      })}
    />,
  );
  await waitFor(() =>
    expect(within(document.body).getByRole("button", { name: /Model provider/ })).toBeTruthy(),
  );
  await user.click(within(document.body).getByRole("button", { name: /Model provider/ }));
  await user.click(within(document.body).getByRole("option", { name: "openai" }));
  const key = within(document.body).getByLabelText("openai API key") as HTMLInputElement;
  await user.type(key, "secret-key");
  await user.click(within(document.body).getByRole("button", { name: /Model provider/ }));
  await user.click(within(document.body).getByRole("option", { name: "anthropic" }));
  expect(within(document.body).getByLabelText("anthropic API key")).toBe(key);
  expect(key.value).toBe("");
});

test("requires a new credential after leaving the configured model provider", async () => {
  const user = userEvent.setup();
  render(
    <AgentRuntimeFields
      open
      computerId="computer-1"
      initial={{ provider: "coforge", modelProvider: "openai", model: "gpt-5", reasoning: "" }}
      credentialConfigured
      onLoad={async () => ({
        providers: [],
        catalogs: [
          { provider: "coforge", models: [model, { ...model, modelProvider: "anthropic" }] },
        ],
      })}
    />,
  );
  await waitFor(() => expect(within(document.body).getByLabelText("openai API key")).toBeTruthy());
  expect(within(document.body).getByLabelText("openai API key").hasAttribute("required")).toBe(
    false,
  );
  await user.click(within(document.body).getByRole("button", { name: /Model provider/ }));
  await user.click(within(document.body).getByRole("option", { name: "anthropic" }));
  expect(within(document.body).getByLabelText("anthropic API key").hasAttribute("required")).toBe(
    true,
  );
});

test("external runtimes show their complete model catalog", async () => {
  const user = userEvent.setup();
  render(
    <AgentRuntimeFields
      open
      computerId="computer-1"
      initial={{ provider: "codex", modelProvider: "", model: "", reasoning: "" }}
      onLoad={async () => ({
        providers: ["codex"],
        catalogs: [{ provider: "codex", models: [model] }],
      })}
    />,
  );
  await waitFor(() =>
    expect(within(document.body).getByRole("button", { name: isModelSelect })).toBeTruthy(),
  );
  await user.click(within(document.body).getByRole("button", { name: isModelSelect }));
  expect(within(document.body).getByRole("option", { name: "openai / GPT 5" })).toBeTruthy();
});

test("offers Kiro and selects catalog models without a model provider", async () => {
  let submitted: FormData | undefined;
  const user = userEvent.setup();
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
        onLoad={async () => ({
          providers: ["kiro"],
          catalogs: [{ provider: "kiro", models: [{ ...model, modelProvider: "" }] }],
        })}
      />
      <Button type="submit">Save</Button>
    </form>,
  );
  await waitFor(() =>
    expect(within(document.body).getByRole("button", { name: /Runtime provider/ })).toBeTruthy(),
  );
  await user.click(within(document.body).getByRole("button", { name: /Runtime provider/ }));
  await user.click(within(document.body).getByRole("option", { name: "Kiro" }));
  await user.click(within(document.body).getByRole("button", { name: isModelSelect }));
  await user.click(within(document.body).getByRole("option", { name: "GPT 5" }));
  expect(within(document.body).getByRole("button", { name: isModelSelect }).textContent).toBe(
    "GPT 5",
  );
  await user.click(within(document.body).getByRole("button", { name: "Save" }));

  expect(Object.fromEntries(submitted!)).toMatchObject({
    provider: "kiro",
    modelProvider: "",
    model: "gpt-5",
  });
  expect(within(document.body).queryByLabelText(/API key/)).toBeNull();
});

test("Pi filters an explicit provider and deduplicates local models before CoForge models", async () => {
  const user = userEvent.setup();
  render(
    <AgentRuntimeFields
      open
      computerId="computer-1"
      initial={{ provider: "pi", modelProvider: "", model: "", reasoning: "" }}
      onLoad={async () => ({
        providers: ["pi"],
        catalogs: [
          { provider: "coforge", models: [{ ...model, displayName: "Cloud duplicate" }] },
          {
            provider: "pi",
            models: [
              model,
              { ...model, id: "claude", displayName: "Claude", modelProvider: "anthropic" },
            ],
          },
        ],
      })}
    />,
  );
  await waitFor(() =>
    expect(within(document.body).getByRole("button", { name: /Model provider/ })).toBeTruthy(),
  );
  await user.click(within(document.body).getByRole("button", { name: isModelSelect }));
  expect(within(document.body).getAllByRole("option", { name: "openai / GPT 5" })).toHaveLength(1);
  expect(within(document.body).queryByText("Cloud duplicate")).toBeNull();
  await user.keyboard("{Escape}");
  await user.click(within(document.body).getByRole("button", { name: /Model provider/ }));
  await user.click(within(document.body).getByRole("option", { name: "anthropic" }));
  await user.click(within(document.body).getByRole("button", { name: isModelSelect }));
  expect(within(document.body).getByRole("option", { name: "anthropic / Claude" })).toBeTruthy();
  expect(within(document.body).queryByRole("option", { name: "openai / GPT 5" })).toBeNull();
});

test("keeps a drafted API key when selecting another model from the same provider", async () => {
  const user = userEvent.setup();
  render(
    <AgentRuntimeFields
      open
      computerId="computer-1"
      onLoad={async () => ({
        providers: [],
        catalogs: [
          {
            provider: "coforge",
            models: [model, { ...model, id: "gpt-5-mini", displayName: "GPT 5 mini" }],
          },
        ],
      })}
    />,
  );
  await waitFor(() =>
    expect(within(document.body).getByRole("button", { name: /Model provider/ })).toBeTruthy(),
  );
  await user.click(within(document.body).getByRole("button", { name: /Model provider/ }));
  await user.click(within(document.body).getByRole("option", { name: "openai" }));
  const key = within(document.body).getByLabelText("openai API key") as HTMLInputElement;
  await user.type(key, "secret-key");
  await user.click(within(document.body).getByRole("button", { name: isModelSelect }));
  await user.click(within(document.body).getByRole("option", { name: "openai / GPT 5 mini" }));
  expect(key.value).toBe("secret-key");
});

test("clears a drafted API key when the Computer changes", async () => {
  const user = userEvent.setup();
  const load = async () => ({
    providers: [],
    catalogs: [{ provider: "coforge", models: [model] }],
  });
  const view = render(<AgentRuntimeFields open computerId="computer-1" onLoad={load} />);
  await waitFor(() =>
    expect(within(document.body).getByRole("button", { name: /Model provider/ })).toBeTruthy(),
  );
  await user.click(within(document.body).getByRole("button", { name: /Model provider/ }));
  await user.click(within(document.body).getByRole("option", { name: "openai" }));
  const key = within(document.body).getByLabelText("openai API key") as HTMLInputElement;
  await user.type(key, "secret-key");
  view.rerender(<AgentRuntimeFields open computerId="computer-2" onLoad={load} />);
  await waitFor(() => expect(key.value).toBe(""));
});
