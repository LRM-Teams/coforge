import "./dom-setup";

import { afterEach, expect, mock, test } from "bun:test";
import { RouterContextProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";

import { AppShell } from "@/components/app-shell";
import { AgentsContent } from "@/features/agents/agents-content";
import { overwriteGetLocale } from "@/paraglide/runtime";
import { getRouter } from "@/router";

const user = { name: "Frank An", email: "frank@example.com" };

afterEach(cleanup);

const agent = {
  id: "agent-1",
  name: "release-helper",
  displayName: "Release Helper",
  createdAt: "2026-08-20T12:00:00.000Z",
  runtimeConfig: { provider: "codex" as const, model: "gpt-5" },
};
const computers = [
  {
    id: "computer-1",
    machineId: "machine-1",
    runtimes: [{ provider: "codex" }, { provider: "claude-code" }],
    modelCatalogs: [
      {
        provider: "claude-code",
        models: [
          {
            id: "sonnet",
            displayName: "Sonnet",
            description: "",
            modelProvider: "",
            reasoningEfforts: ["low", "high"],
            defaultReasoning: "high",
            recommended: true,
          },
        ],
      },
    ],
  },
];

function renderShell(agents = [agent], onCreate = async () => ({ startPublished: true })) {
  return render(
    <RouterContextProvider router={getRouter()}>
      <AppShell user={user}>
        <AgentsContent agents={agents} computers={computers} onCreate={onCreate} />
      </AppShell>
    </RouterContextProvider>,
  ).container.innerHTML;
}

function page() {
  return within(document.body);
}

function renderAgents(
  agents = [agent],
  onCreate = async () => ({ startPublished: true }),
  defaultCreateDialogOpen = false,
) {
  render(
    <AgentsContent
      agents={agents}
      computers={computers}
      onCreate={onCreate}
      defaultCreateDialogOpen={defaultCreateDialogOpen}
    />,
  );
}

test("shows the primary navigation with Members selected", () => {
  const markup = renderShell();

  expect(markup).toContain("<aside");
  expect(markup).toContain("Members");
  expect(markup).toContain("Messages");
  expect(markup).toContain("Computers");
  expect(markup.indexOf("Members")).toBeLessThan(markup.indexOf("Messages"));
  expect(markup.indexOf("Messages")).toBeLessThan(markup.indexOf("Computers"));
  expect(markup).toContain('href="/en/messages"');
  expect(markup).toContain('aria-label="Current user"');
  expect(markup).toContain(">F</span>");
  expect(markup).toContain('aria-current="page"');
});

test("keeps Messages selected on a private conversation route", () => {
  window.history.pushState({}, "", "/en/messages/agent-1");
  const router = getRouter();
  render(
    <RouterContextProvider router={router}>
      <AppShell user={user}>Conversation</AppShell>
    </RouterContextProvider>,
  );

  expect(page().getByRole("link", { name: "Messages" }).getAttribute("aria-current")).toBe("page");
  window.history.pushState({}, "", "/en");
});

test("renders persisted Agent fields without fabricated details", () => {
  const markup = renderShell();

  expect(markup).toContain("<header");
  expect(markup).toContain("<main");
  expect(markup).toContain("Agent overview");
  expect(markup).toContain("New agent");
  expect(markup).toContain("Search agents");
  expect(markup).toContain("Release Helper");
  expect(markup).toContain("@release-helper");
  expect(markup).toContain("Codex / gpt-5");
  expect(markup).toContain('href="/en/messages/agent-1"');
  expect(markup).not.toContain("Private chat is coming");
  expect(markup.match(/data-agent-card/g)?.length).toBe(1);
});

test("shows an empty state", () => {
  renderAgents([]);
  expect(page().getByText("No agents yet")).toBeTruthy();
});

test("submits the public creation form callback", async () => {
  const onCreate = mock(async () => ({ startPublished: true }));
  renderAgents([], onCreate, true);
  expect(await page().findByRole("option", { name: "Pi (Built-in)" })).toBeTruthy();
  fireEvent.change(await page().findByLabelText("Name"), { target: { value: "build-helper" } });
  fireEvent.change(page().getByLabelText("Display name"), { target: { value: "Build Helper" } });
  fireEvent.change(page().getByLabelText("Runtime provider"), { target: { value: "claude-code" } });
  fireEvent.change(page().getByLabelText(/Model/), {
    target: { value: JSON.stringify(["", "sonnet"]) },
  });
  fireEvent.change(page().getByLabelText(/Reasoning/), { target: { value: "high" } });
  fireEvent.click(page().getByRole("button", { name: "Create agent" }));
  await waitFor(() =>
    expect(onCreate).toHaveBeenCalledWith({
      name: "build-helper",
      displayName: "Build Helper",
      provider: "claude-code",
      model: "sonnet",
      reasoning: "high",
      computerId: "computer-1",
    }),
  );
});

test("shows a deferred-start notice after creation", async () => {
  renderAgents([], async () => ({ startPublished: false }), true);
  fireEvent.change(await page().findByLabelText("Name"), { target: { value: "helper" } });
  fireEvent.change(page().getByLabelText("Display name"), { target: { value: "Helper" } });
  fireEvent.click(page().getByRole("button", { name: "Create agent" }));
  expect((await page().findByRole("status")).textContent).toBe(
    "Agent created. It will start when Daemon reconnects.",
  );
});

test("collapsing the sidebar keeps navigation and the user menu reachable", () => {
  render(
    <RouterContextProvider router={getRouter()}>
      <AppShell user={user}>
        <AgentsContent
          agents={[agent]}
          computers={computers}
          onCreate={async () => ({ startPublished: true })}
        />
      </AppShell>
    </RouterContextProvider>,
  );

  fireEvent.click(page().getByRole("button", { name: "Hide sidebar" }));

  // Exactly one of each stays in the DOM, so the collapsed copies never
  // duplicate the sidebar's links for assistive technology.
  expect(page().getAllByRole("navigation", { name: "Primary navigation" }).length).toBe(1);
  expect(page().getAllByLabelText("Current user").length).toBe(1);
  for (const name of ["Members", "Messages", "Computers"]) {
    expect(page().getByRole("link", { name }).getAttribute("href")).toBeTruthy();
  }
});

test("renders the same shell from the Simplified Chinese catalog", () => {
  overwriteGetLocale(() => "zh-CN");
  const markup = renderShell();
  overwriteGetLocale(() => "en");

  expect(markup).toContain("成员");
  expect(markup).toContain("智能体汇总");
  expect(markup).toContain("新建智能体");
});
