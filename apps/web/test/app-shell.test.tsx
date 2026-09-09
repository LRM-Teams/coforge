import "./dom-setup";

import { afterEach, expect, jest, mock, test } from "bun:test";
import { RouterContextProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ComponentProps } from "react";

import { AppShell } from "@/components/app-shell";
import { AppToastProvider } from "@/components/ui/toast";
import type { AgentView } from "@/features/agents/agents-content";
import { AgentsContent as MembersContent } from "@/features/agents/agents-content";
import { overwriteGetLocale } from "@/paraglide/runtime";
import { getRouter } from "@/router";

const user = { name: "Frank An", email: "frank@example.com" };

function AgentsContent(
  props: Omit<ComponentProps<typeof MembersContent>, "memberType" | "onMemberTypeChange">,
) {
  const [memberType, setMemberType] = useState<"all" | "human" | "agent">("all");
  return <MembersContent {...props} memberType={memberType} onMemberTypeChange={setMemberType} />;
}

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
  status: { value: "inactive" as const, expiresAt: null },
};
const agentDirectory = {
  people: [],
  agents: [{ ...agent, description: "", computerName: "Office computer" }],
};
const computers = [
  {
    id: "computer-1",
    name: "franks-macbook-pro",
    displayName: "Frank’s MacBook Pro",
    runtimes: [{ provider: "codex" }, { provider: "claude-code" }],
  },
];
const modelCatalogs = [
  {
    provider: "coforge",
    models: [
      {
        id: "gpt-5",
        displayName: "GPT-5",
        description: "",
        modelProvider: "openai",
        reasoningEfforts: ["medium"],
        defaultReasoning: "medium",
        recommended: true,
      },
      {
        id: "claude-sonnet",
        displayName: "Claude Sonnet",
        description: "",
        modelProvider: "anthropic",
        reasoningEfforts: [],
        defaultReasoning: "",
        recommended: false,
      },
    ],
  },
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
];

function renderShell(
  agents: AgentView[] = [agent],
  onCreate = async () => ({ startPublished: true }),
) {
  return render(
    <RouterContextProvider router={getRouter()}>
      <AppToastProvider>
        <AppShell user={user}>
          <AgentsContent
            directory={{
              people: [],
              agents: agents.map((item) => ({
                ...item,
                description: item.description ?? "",
                computerName: "Office computer",
              })),
            }}
            agents={agents}
            computers={computers}
            onCreate={onCreate}
            onLoadRuntimeCatalog={async () => modelCatalogs}
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
  onLoadRuntimeCatalog = async () => modelCatalogs,
  availableComputers = computers,
) {
  render(
    <RouterContextProvider router={getRouter()}>
      <AgentsContent
        directory={{
          people: [],
          agents: agents.map((item) => ({
            ...item,
            description: item.description ?? "",
            computerName: "Office computer",
          })),
        }}
        agents={agents}
        computers={availableComputers}
        onCreate={onCreate}
        onLoadRuntimeCatalog={onLoadRuntimeCatalog}
        defaultCreateDialogOpen={defaultCreateDialogOpen}
      />
    </RouterContextProvider>,
  );
}

test("shows the icon-only CoForge brand and current Workspace", () => {
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

  // NOTE: the official SidebarNavigationSimple (unmodified) always renders
  // Untitled's own `<UntitledLogo>` wordmark internally, with no prop to
  // replace it with CoForge's brand mark — a known, flagged limitation of
  // the official component (see the report). There's nothing app-shell.tsx
  // can do about the logo without editing that file, so this test only
  // covers what CoForge actually controls: the workspace switcher.
  expect(page().getByRole("button", { name: "Current workspace" }).textContent).toContain(
    "LRM-Team",
  );
});

test("shows an icon with the Sign out action", async () => {
  render(
    <RouterContextProvider router={getRouter()}>
      <AppToastProvider>
        <AppShell user={user}>Page</AppShell>
      </AppToastProvider>
    </RouterContextProvider>,
  );

  await userEvent.setup({ document }).click(page().getByRole("button", { name: "Current user" }));
  expect(
    (await page().findByRole("menuitem", { name: "Sign out" })).querySelector("svg"),
  ).toBeTruthy();
});

test("shows the primary navigation with Members selected", () => {
  const markup = renderShell();

  expect(markup).toContain("<aside");
  expect(markup).toContain("Members");
  expect(markup).toContain("Messages");
  expect(markup).toContain("Tasks");
  expect(markup).toContain("Computers");
  expect(markup.indexOf("Members")).toBeLessThan(markup.indexOf("Messages"));
  expect(markup.indexOf("Messages")).toBeLessThan(markup.indexOf("Tasks"));
  expect(markup.indexOf("Tasks")).toBeLessThan(markup.indexOf("Computers"));
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

test("keeps Tasks selected in expanded and collapsed navigation", async () => {
  window.history.pushState({}, "", "/en/tasks");
  render(
    <RouterContextProvider router={getRouter()}>
      <AppToastProvider>
        <AppShell user={user}>Tasks</AppShell>
      </AppToastProvider>
    </RouterContextProvider>,
  );

  expect(page().getByRole("link", { name: "Tasks" }).getAttribute("aria-current")).toBe("page");
  fireEvent.keyDown(document, { key: "b", code: "KeyB", ctrlKey: true });
  fireEvent.keyUp(document, { key: "b", code: "KeyB", ctrlKey: true });
  const collapsedTask = page().getByRole("link", { name: "Tasks" });
  // Official SidebarNavigationSlim's NavButton (base-components/nav-button.tsx,
  // unmodified) has no `aria-current` — it marks the current item visually only,
  // with a bg-secondary class.
  expect(collapsedTask.className).toContain("bg-secondary");
  window.history.pushState({}, "", "/en");
});

test("renders persisted Agent fields without fabricated details", () => {
  const markup = renderShell();

  expect(markup).toContain("<main");
  expect(page().getByRole("heading", { name: "Members", level: 1 })).toBeTruthy();
  expect(markup).toContain("New agent");
  expect(markup).toContain("Search members");
  expect(markup).toContain("Release Helper");
  expect(markup).toContain("@release-helper");
  expect(markup).toContain("Office computer");
  expect(markup).not.toContain("Codex / gpt-5");
  expect(page().queryByRole("button", { name: "Retry start" })).toBeNull();
  expect(page().getByRole("link", { name: "Release Helper" }).getAttribute("href")).toContain(
    "/agents/agent-1",
  );
  expect(markup).toContain('href="/en/messages/agent-1"');
  const chat = page().getByRole("link", { name: "Private chat" });
  expect(chat.textContent).toBe("");
  expect(chat.querySelector("svg")).toBeTruthy();
  expect(markup).not.toContain("Private chat is coming");
  expect(page().getByRole("list", { name: "Members" }).children.length).toBe(1);
});

test("shows Agent status on the avatar", () => {
  renderShell([
    { ...agent, status: { value: "active", expiresAt: Date.now() + 60_000 } },
    {
      ...agent,
      id: "agent-2",
      name: "research-helper",
      displayName: "Research Helper",
      status: { value: "inactive", expiresAt: null },
    },
  ]);

  const activeCard = page().getByText("Release Helper").closest("li");
  const inactiveCard = page().getByText("Research Helper").closest("li");
  if (!(activeCard instanceof HTMLElement) || !(inactiveCard instanceof HTMLElement))
    throw new Error("Agent cards were not rendered");
  // The official Avatar's own status dot (base-components/avatar-online-indicator.tsx,
  // unmodified) uses Untitled's own success/neutral tokens, not a CoForge-specific one.
  expect(activeCard.querySelector("[data-avatar] > span.bg-fg-success-secondary")).toBeTruthy();
  expect(inactiveCard.querySelector("[data-avatar] > span.bg-utility-neutral-300")).toBeTruthy();
  // The official Avatar has no `statusLabel` prop; presence text is a
  // visually-hidden sibling span instead of a combined `role="img"` name.
  expect(within(activeCard).getByText("Online")).toBeTruthy();
  expect(within(inactiveCard).getByText("Offline")).toBeTruthy();
});

test("explains the Computer prerequisite only after requesting a new Agent", async () => {
  renderAgents([], undefined, false, undefined, []);
  expect(page().queryByRole("link", { name: "Connect a computer" })).toBeNull();
  expect(page().queryByRole("heading", { name: "Connect a computer first" })).toBeNull();
  const browserUser = userEvent.setup({ document });
  await browserUser.click(page().getByRole("button", { name: "New agent" }));
  expect(page().getByRole("dialog")).toBeTruthy();
  expect(page().getByRole("link", { name: "Connect a computer" }).getAttribute("href")).toBe(
    "/en/computers",
  );
  expect(page().queryByRole("textbox", { name: "Name" })).toBeNull();
  await browserUser.click(page().getByRole("button", { name: "Cancel" }));
  expect(page().queryByRole("dialog")).toBeNull();
});

test("shows an empty state", () => {
  renderAgents([]);
  expect(page().getByText("No agents yet")).toBeTruthy();
});

test("shows Workspace humans and other owners' Agents without granting Agent actions", async () => {
  render(
    <RouterContextProvider router={getRouter()}>
      <AgentsContent
        directory={{
          people: [
            { id: "person", name: "ada", displayName: "Ada Lovelace", description: "Engineer" },
          ],
          agents: [
            {
              id: "other-agent",
              name: "builder",
              displayName: "Team Builder",
              description: "Build releases",
              computerName: "Shared workstation",
            },
            {
              id: "second-agent",
              name: "reviewer",
              displayName: "Reviewer",
              description: "",
              computerName: null,
            },
          ],
        }}
        agents={[]}
        computers={[]}
        onCreate={async () => ({ startPublished: true })}
        onLoadRuntimeCatalog={async () => []}
      />
    </RouterContextProvider>,
  );
  expect(page().getByText("Ada Lovelace")).toBeTruthy();
  expect(page().getByText("Team Builder")).toBeTruthy();
  expect(page().getByText("Shared workstation")).toBeTruthy();
  expect(page().getByRole("button", { name: "All" }).textContent).toBe("All3");
  expect(page().getByRole("button", { name: "Human" }).textContent).toBe("Human1");
  expect(page().getByRole("button", { name: "Agent" }).textContent).toBe("Agent2");
  expect(page().getByText("Ada Lovelace").closest("li")?.textContent).not.toContain("computer");
  expect(page().getByText("Ada Lovelace").closest("li")?.textContent).not.toContain("Offline");
  expect(page().getByText("No computer assigned")).toBeTruthy();
  expect(page().queryByText("No agents yet")).toBeNull();
  expect(page().queryByRole("link", { name: "Private chat" })).toBeNull();
  expect(page().queryByRole("button", { name: "Retry start" })).toBeNull();
  const browserUser = userEvent.setup({ document });
  await browserUser.click(page().getByRole("button", { name: "Human" }));
  expect(page().getByText("Ada Lovelace")).toBeTruthy();
  expect(page().queryByText("Team Builder")).toBeNull();
  await browserUser.click(page().getByRole("button", { name: "Agent" }));
  expect(page().getByText("Team Builder")).toBeTruthy();
  expect(page().queryByText("Ada Lovelace")).toBeNull();
  await browserUser.type(page().getByRole("searchbox"), "ada");
  expect(page().queryByText("Ada Lovelace")).toBeNull();
  expect(page().getByRole("button", { name: "Agent" }).textContent).toBe("Agent2");
  await browserUser.click(page().getByRole("button", { name: "All" }));
  expect(page().getByText("Ada Lovelace")).toBeTruthy();
  await browserUser.clear(page().getByRole("searchbox"));
  await browserUser.type(page().getByRole("searchbox"), "ada");
  expect(page().getByText("Ada Lovelace")).toBeTruthy();
  expect(page().queryByText("Team Builder")).toBeNull();
  await browserUser.clear(page().getByRole("searchbox"));
  await browserUser.type(page().getByRole("searchbox"), "workstation");
  expect(page().getByText("Team Builder")).toBeTruthy();
  expect(page().queryByText("Ada Lovelace")).toBeNull();
});

test("recovers the Agent list from an unmatched search", async () => {
  renderAgents();
  const browserUser = userEvent.setup({ document });
  const search = page().getByRole("searchbox");
  await browserUser.type(search, "missing-agent");
  expect(page().getByRole("heading", { name: "No members match your search" })).toBeTruthy();
  expect(page().queryByText("Release Helper")).toBeNull();
  expect(page().queryByText("No agents yet")).toBeNull();
  fireEvent.click(page().getByRole("button", { name: "Clear search" }));
  expect(search.getAttribute("value")).toBe("");
  expect(page().getByText("Release Helper")).toBeTruthy();
  await browserUser.type(search, "   ");
  expect(page().getByText("Release Helper")).toBeTruthy();
  expect(page().queryByRole("button", { name: "Clear search" })).toBeNull();
});

test("loads model catalogs only when the creation dialog opens", async () => {
  const loadRuntimeCatalog = mock(async () => modelCatalogs);
  renderAgents([], undefined, false, loadRuntimeCatalog);

  expect(loadRuntimeCatalog).not.toHaveBeenCalled();
  fireEvent.click(page().getByRole("button", { name: "New agent" }));

  await waitFor(() => expect(loadRuntimeCatalog).toHaveBeenCalledWith("computer-1"));
  expect(page().getByText("Frank’s MacBook Pro")).toBeTruthy();
  expect(document.body.textContent).not.toContain("machine-1");
  fireEvent.click(page().getByRole("button", { name: "Cancel" }));
  fireEvent.click(page().getByRole("button", { name: "New agent" }));
  await act(async () => {});
  // The official Modal/ModalOverlay (application/modals/modal.tsx, unmodified)
  // fully unmounts its content on close — there's no "keep mounted, just
  // hidden" option like the previous hand-adapted Dialog had (via React's
  // experimental Activity API) — so reopening genuinely refetches.
  expect(loadRuntimeCatalog).toHaveBeenCalledTimes(2);
});

test("offers to retry when a model catalog request fails", async () => {
  const loadRuntimeCatalog = mock(async () => {
    if (loadRuntimeCatalog.mock.calls.length === 1) throw new Error("catalog unavailable");
    return modelCatalogs;
  });
  renderAgents([], undefined, true, loadRuntimeCatalog);

  await waitFor(() => expect(page().getByRole("button", { name: "Try again" })).toBeTruthy());
  fireEvent.click(page().getByRole("button", { name: "Try again" }));

  await waitFor(() => expect(loadRuntimeCatalog).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(page().queryByRole("button", { name: "Try again" })).toBeNull());
});

test("submits a manual CoForge model when catalog loading fails", async () => {
  const onCreate = mock(async () => ({ startPublished: true }));
  renderAgents([], onCreate, true, async () => {
    throw new Error("catalog unavailable");
  });
  fireEvent.change(await page().findByLabelText("Name"), {
    target: { value: "manual-agent" },
  });
  fireEvent.change(page().getByPlaceholderText("What should this Agent help with?"), {
    target: { value: "Manual catalog fallback" },
  });
  await waitFor(() =>
    expect(page().getByText(/Enter the provider and model ID manually/)).toBeTruthy(),
  );
  fireEvent.change(page().getByLabelText("Model provider"), {
    target: { value: "deepseek" },
  });
  fireEvent.change(page().getByLabelText("Model"), {
    target: { value: "deepseek-chat" },
  });
  fireEvent.click(page().getByRole("button", { name: "Create agent" }));
  await waitFor(() =>
    expect(onCreate).toHaveBeenCalledWith({
      name: "manual-agent",
      description: "Manual catalog fallback",
      provider: "coforge",
      model: "deepseek-chat",
      modelProvider: "deepseek",
      reasoning: "",
      computerId: "computer-1",
    }),
  );
});

test("submits the public creation form callback", async () => {
  const browserUser = userEvent.setup({ document });
  const onCreate = mock(async () => ({ startPublished: true }));
  renderAgents([], onCreate, true);
  fireEvent.change(await page().findByLabelText("Name"), {
    target: { value: "build-helper" },
  });
  fireEvent.change(page().getByPlaceholderText("What should this Agent help with?"), {
    target: { value: "Build and release helper" },
  });
  await browserUser.click(page().getByRole("button", { name: /Runtime provider/ }));
  await browserUser.click(page().getByRole("option", { name: "Claude Code" }));
  await browserUser.click(page().getByRole("button", { name: /Model/ }));
  await browserUser.click(page().getByRole("option", { name: "Sonnet" }));
  await browserUser.click(page().getByRole("button", { name: /Reasoning/ }));
  await browserUser.click(page().getByRole("option", { name: "high" }));
  fireEvent.click(page().getByRole("button", { name: "Create agent" }));
  await waitFor(() =>
    expect(onCreate).toHaveBeenCalledWith({
      name: "build-helper",
      description: "Build and release helper",
      provider: "claude-code",
      model: "sonnet",
      reasoning: "high",
      computerId: "computer-1",
    }),
  );
});

test("selects a CoForge model provider before its model", async () => {
  const browserUser = userEvent.setup({ document });
  const onCreate = mock(async () => ({ startPublished: true }));
  renderAgents([], onCreate, true);
  fireEvent.change(await page().findByLabelText("Name"), {
    target: { value: "model-helper" },
  });
  fireEvent.change(page().getByPlaceholderText("What should this Agent help with?"), {
    target: { value: "Uses a selected model provider" },
  });
  await browserUser.click(page().getByRole("button", { name: /Model provider/ }));
  await browserUser.click(page().getByRole("option", { name: "anthropic" }));
  await browserUser.click(page().getByRole("button", { name: /Model Optional/ }));
  await browserUser.click(page().getByRole("option", { name: "anthropic / Claude Sonnet" }));
  fireEvent.click(page().getByRole("button", { name: "Create agent" }));
  await waitFor(() =>
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "coforge",
        modelProvider: "anthropic",
        model: "claude-sonnet",
      }),
    ),
  );
});

test("shows a deferred-start notice after creation", async () => {
  renderAgents([], async () => ({ startPublished: false }), true);
  fireEvent.change(await page().findByLabelText("Name"), {
    target: { value: "helper" },
  });
  fireEvent.change(page().getByPlaceholderText("What should this Agent help with?"), {
    target: { value: "General purpose helper" },
  });
  fireEvent.click(page().getByRole("button", { name: "Create agent" }));
  expect((await page().findByRole("status")).textContent).toBe(
    "Agent created. It will start when Daemon reconnects.",
  );
});

test("collapsing the sidebar keeps navigation and the user menu reachable", () => {
  render(
    <RouterContextProvider router={getRouter()}>
      <AppToastProvider>
        <AppShell user={user}>
          <AgentsContent
            directory={agentDirectory}
            agents={[agent]}
            computers={computers}
            onCreate={async () => ({ startPublished: true })}
            onLoadRuntimeCatalog={async () => modelCatalogs}
          />
        </AppShell>
      </AppToastProvider>
    </RouterContextProvider>,
  );

  fireEvent.click(page().getByRole("button", { name: "Hide sidebar" }));

  // The official SidebarNavigationSlim (unmodified) has no `<nav>` landmark
  // around its item list and no "Current user" trigger (see the note on the
  // other collapsed-sidebar tests) — only one aside stays in the DOM, and
  // its links remain reachable.
  expect(page().getAllByRole("complementary").length).toBe(1);
  for (const name of ["Members", "Messages", "Computers"]) {
    expect(page().getByRole("link", { name }).getAttribute("href")).toBeTruthy();
  }
});

test("keeps main content state across desktop collapse and the mobile drawer", async () => {
  function StatefulPage() {
    const [value, setValue] = useState("");
    return (
      <main>
        <input
          aria-label="Page state"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </main>
    );
  }

  render(
    <RouterContextProvider router={getRouter()}>
      <AppToastProvider>
        <AppShell user={user}>
          <StatefulPage />
        </AppShell>
      </AppToastProvider>
    </RouterContextProvider>,
  );

  const browserUser = userEvent.setup({ document });
  const state = page().getByRole("textbox", { name: "Page state" });
  fireEvent.input(state, { target: { value: "preserved" } });

  // Desktop collapse: `{children}` is rendered once, outside the
  // expanded/collapsed sidebar conditional, so toggling never remounts it.
  fireEvent.keyDown(document, { key: "b", code: "KeyB", ctrlKey: true });
  fireEvent.keyUp(document, { key: "b", code: "KeyB", ctrlKey: true });
  expect(page().getByRole("textbox", { name: "Page state" })).toBe(state);
  expect((state as HTMLInputElement).value).toBe("preserved");
  fireEvent.keyDown(document, { key: "b", code: "KeyB", ctrlKey: true });
  fireEvent.keyUp(document, { key: "b", code: "KeyB", ctrlKey: true });

  // Mobile drawer: the official sidebar's own modal overlay is a sibling of
  // `{children}` (a React portal, not a remount of it), so opening it must
  // not touch the page's state either.
  await browserUser.click(page().getByRole("button", { name: "Expand navigation menu" }));
  expect(page().getByRole("button", { name: "Close navigation menu" })).toBeTruthy();
  expect(page().getByRole("textbox", { name: "Page state" })).toBe(state);
  expect((state as HTMLInputElement).value).toBe("preserved");
});

test("the mobile navigation menu opens and closes with its own hamburger button", async () => {
  const browserUser = userEvent.setup({ document });
  renderShell();

  // The official sidebar (SidebarNavigationSimple, unmodified) ships its own
  // persistent mobile header with a hamburger trigger and a modal drawer;
  // CoForge no longer maintains a separate per-page toggle for this. NOTE:
  // unlike the previous hand-built drawer, the official NavList/NavItemBase
  // render plain links with no per-item onClick hook, so selecting a nav
  // link (or a Personal Settings menu item) no longer auto-closes the
  // drawer — there's no prop/slot on the official component to hook a
  // close call into. Closing is manual, via the drawer's own X button.
  const menu = page().getByRole("button", { name: "Expand navigation menu" });
  expect(menu.getAttribute("aria-expanded")).toBe("false");
  await browserUser.click(menu);
  expect(menu.getAttribute("aria-expanded")).toBe("true");
  await browserUser.click(page().getByRole("button", { name: "Close navigation menu" }));
  expect(menu.getAttribute("aria-expanded")).toBe("false");
});

test("renders the same shell from the Simplified Chinese catalog", () => {
  overwriteGetLocale(() => "zh-CN");
  const markup = renderShell();
  overwriteGetLocale(() => "en");

  expect(markup).toContain("成员");
  expect(markup).toContain("智能体");
  expect(page().getByRole("heading", { name: "成员", level: 1 })).toBeTruthy();
  expect(markup).toContain("新建智能体");
});
