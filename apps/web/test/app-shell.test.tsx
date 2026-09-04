import "./dom-setup";

import { afterEach, expect, jest, mock, test } from "bun:test";
import { RouterContextProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AppShell } from "@/components/app-shell";
import { AppToastProvider } from "@/components/ui/toast";
import type { AgentView } from "@/features/agents/agent-card";
import { AgentsContent } from "@/features/agents/agents-content";
import { overwriteGetLocale } from "@/paraglide/runtime";
import { getRouter } from "@/router";

const user = { name: "Frank An", email: "frank@example.com" };

afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

const agent = {
  id: "agent-1",
  name: "release-helper",
  displayName: "Release Helper",
  createdAt: "2026-08-20T12:00:00.000Z",
  runtimeConfig: {
    runtime: "codex" as const,
    provider: { kind: "default" as const },
    model: "gpt-5",
  },
  status: "inactive" as const,
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

function renderShell(
  agents: AgentView[] = [agent],
  onCreate = async () => ({ startPublished: true }),
  onRetry = async () => {},
) {
  return render(
    <RouterContextProvider router={getRouter()}>
      <AppToastProvider>
        <AppShell user={user}>
          <AgentsContent
            agents={agents}
            computers={computers}
            onCreate={onCreate}
            onRetry={onRetry}
          />
        </AppShell>
      </AppToastProvider>
    </RouterContextProvider>,
  ).container.innerHTML;
}

function page() {
  return within(document.body);
}

function renderAgents(
  agents: AgentView[] = [agent],
  onCreate = async () => ({ startPublished: true }),
  defaultCreateDialogOpen = false,
  onRetry = async () => {},
) {
  render(
    <RouterContextProvider router={getRouter()}>
      <AgentsContent
        agents={agents}
        computers={computers}
        onCreate={onCreate}
        onRetry={onRetry}
        defaultCreateDialogOpen={defaultCreateDialogOpen}
      />
    </RouterContextProvider>,
  );
}

test("shows the current Workspace below the logo", () => {
  render(
    <RouterContextProvider router={getRouter()}>
      <AppToastProvider>
        <AppShell
          user={user}
          workspaces={[{ id: "ws-1", slug: "lrm-team", name: "LRM-Team" }]}
          currentWorkspace={{ id: "ws-1", slug: "lrm-team", name: "LRM-Team" }}
        >
          Page
        </AppShell>
      </AppToastProvider>
    </RouterContextProvider>,
  );

  expect(page().getByAltText("CoForge")).toBeTruthy();
  expect(page().getByRole("button", { name: "Current workspace" }).textContent).toContain(
    "LRM-Team",
  );
});

test("shows the primary navigation with Agents selected", () => {
  const markup = renderShell();

  expect(markup).toContain("<aside");
  expect(markup).toContain("Agents");
  expect(markup).toContain("Messages");
  expect(markup).toContain("Computers");
  expect(markup.indexOf("Agents")).toBeLessThan(markup.indexOf("Messages"));
  expect(markup.indexOf("Messages")).toBeLessThan(markup.indexOf("Computers"));
  expect(markup).toContain('href="/en/messages"');
  expect(markup).toContain('aria-label="Current user"');
  expect(markup).toContain(">F</span>");
});

test("keeps Messages selected on a private conversation route", () => {
  window.history.pushState({}, "", "/en/messages/agent-1");
  const router = getRouter();
  render(
    <RouterContextProvider router={router}>
      <AppToastProvider>
        <AppShell user={user}>Conversation</AppShell>
      </AppToastProvider>
    </RouterContextProvider>,
  );

  expect(page().getByRole("link", { name: "Messages" }).getAttribute("aria-current")).toBe("page");
  window.history.pushState({}, "", "/en");
});

test("renders persisted Agent fields without fabricated details", () => {
  const markup = renderShell();

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

test("shows Agent status on the avatar", () => {
  renderShell([
    { ...agent, status: "active" },
    {
      ...agent,
      id: "agent-2",
      name: "research-helper",
      displayName: "Research Helper",
      status: "inactive",
    },
  ]);

  const activeCard = page().getByText("Release Helper").closest("[data-agent-card]");
  const inactiveCard = page().getByText("Research Helper").closest("[data-agent-card]");
  if (!(activeCard instanceof HTMLElement) || !(inactiveCard instanceof HTMLElement))
    throw new Error("Agent cards were not rendered");
  expect(activeCard.querySelector("span.relative.flex.shrink-0 > span.bg-success")).toBeTruthy();
  expect(inactiveCard.querySelector("span.relative.flex.shrink-0 > span.bg-offline")).toBeTruthy();
  expect(within(activeCard).getByText("Online")).toBeTruthy();
  expect(within(inactiveCard).getByText("Offline")).toBeTruthy();
});

test("shows an empty state", () => {
  renderAgents([]);
  expect(page().getByText("No agents yet")).toBeTruthy();
});

test("submits the public creation form callback", async () => {
  const browserUser = userEvent.setup({ document });
  const onCreate = mock(async () => ({ startPublished: true }));
  renderAgents([], onCreate, true);
  fireEvent.change(await page().findByLabelText("Name"), { target: { value: "build-helper" } });
  fireEvent.change(page().getByLabelText("Display name"), { target: { value: "Build Helper" } });
  await browserUser.click(page().getByRole("combobox", { name: "Runtime provider" }));
  await browserUser.click(page().getByRole("option", { name: "Claude Code" }));
  await browserUser.click(page().getByRole("combobox", { name: /Model/ }));
  await browserUser.click(page().getByRole("option", { name: "Sonnet" }));
  await browserUser.click(page().getByRole("combobox", { name: /Reasoning/ }));
  await browserUser.click(page().getByRole("option", { name: "high" }));
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

test("retries an inactive Agent start", async () => {
  const onRetry = mock(async () => {});
  render(
    <RouterContextProvider router={getRouter()}>
      <AgentsContent
        agents={[agent]}
        computers={computers}
        onCreate={async () => ({ startPublished: true })}
        onRetry={onRetry}
      />
    </RouterContextProvider>,
  );

  fireEvent.click(page().getByRole("button", { name: "Retry start" }));
  await waitFor(() => expect(onRetry).toHaveBeenCalledWith("agent-1"));
});

test("offers retry again after an inactive Agent start request cools down", async () => {
  jest.useFakeTimers();
  const onRetry = mock(async () => {});
  renderAgents([agent], async () => ({ startPublished: true }), false, onRetry);

  fireEvent.click(page().getByRole("button", { name: "Retry start" }));
  await act(async () => {});
  expect(page().getByText("Start requested.")).toBeTruthy();
  expect(page().queryByRole("button", { name: "Retry start" })).toBeNull();

  act(() => jest.advanceTimersByTime(3_000));

  expect(page().getByRole("button", { name: "Retry start" })).toBeTruthy();
  expect(page().queryByText("Start requested.")).toBeNull();
});

test("clears the pending start request when the Agent becomes active", async () => {
  const onRetry = mock(async () => {});
  const view = render(
    <RouterContextProvider router={getRouter()}>
      <AgentsContent
        agents={[agent]}
        computers={computers}
        onCreate={async () => ({ startPublished: true })}
        onRetry={onRetry}
      />
    </RouterContextProvider>,
  );
  fireEvent.click(page().getByRole("button", { name: "Retry start" }));
  await waitFor(() => expect(page().getByText("Start requested.")).toBeTruthy());

  view.rerender(
    <RouterContextProvider router={getRouter()}>
      <AgentsContent
        agents={[{ ...agent, status: "active" }]}
        computers={computers}
        onCreate={async () => ({ startPublished: true })}
        onRetry={onRetry}
      />
    </RouterContextProvider>,
  );

  expect(page().queryByText("Start requested.")).toBeNull();
});

test("collapsing the sidebar keeps navigation and the user menu reachable", () => {
  render(
    <RouterContextProvider router={getRouter()}>
      <AppToastProvider>
        <AppShell user={user}>
          <AgentsContent
            agents={[agent]}
            computers={computers}
            onCreate={async () => ({ startPublished: true })}
            onRetry={async () => {}}
          />
        </AppShell>
      </AppToastProvider>
    </RouterContextProvider>,
  );

  fireEvent.click(page().getByRole("button", { name: "Hide sidebar" }));

  // Exactly one of each stays in the DOM, so the collapsed copies never
  // duplicate the sidebar's links for assistive technology.
  expect(page().getAllByRole("navigation", { name: "Primary navigation" }).length).toBe(1);
  expect(page().getAllByLabelText("Current user").length).toBe(1);
  for (const name of ["Agents", "Messages", "Computers"]) {
    expect(page().getByRole("link", { name }).getAttribute("href")).toBeTruthy();
  }
});

test("renders the same shell from the Simplified Chinese catalog", () => {
  overwriteGetLocale(() => "zh-CN");
  const markup = renderShell();
  overwriteGetLocale(() => "en");

  expect(markup).toContain("智能体");
  expect(markup).toContain("智能体汇总");
  expect(markup).toContain("新建智能体");
});
