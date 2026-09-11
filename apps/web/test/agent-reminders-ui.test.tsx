import "./dom-setup";
import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { AgentReminders } from "@/features/agents/agent-reminders";

afterEach(cleanup);

function renderReminders(props: Partial<Parameters<typeof AgentReminders>[0]> = {}) {
  const root = createRootRoute({
    component: () => (
      <AgentReminders
        agentId="agent-1"
        owned
        timeZone="UTC"
        onLoad={async () => ({
          status: "ready",
          reminders: [
            {
              id: "reminder-1",
              title: "Review launch notes\nKeep the rollout checklist intact",
              fireAt: "2026-09-10T10:00:00Z",
              repeat: "daily@09:30",
              timezone: "UTC",
              target: "#launch",
              createdAt: "2026-09-09T10:00:00Z",
              anchor: null,
            },
          ],
          hasMore: false,
          cursor: null,
        })}
        {...props}
      />
    ),
  });
  const router = createRouter({ routeTree: root });
  render(<RouterProvider router={router} />);
}

test("renders the full reminder text, exact schedule, and readable recurrence visibly", async () => {
  renderReminders();
  const page = within(document.body);
  const title = await page.findByText(/Review launch notes/);
  expect(title.closest("li")).toBeTruthy();
  expect(title.textContent).toBe("Review launch notes\nKeep the rollout checklist intact");
  expect(page.getByText("Daily at 09:30")).toBeTruthy();
  expect(await page.findByText(/Sep 10, 2026.*10:00 AM/)).toBeTruthy();
  expect(page.getByText("#launch")).toBeTruthy();
  expect(page.queryByText(/Next:/)).toBeNull();
  expect(page.queryByText(/Recurrence:/)).toBeNull();
  expect(page.queryByText("Once")).toBeNull();
  expect(page.queryByText("View message")).toBeNull();
  expect(page.queryByRole("button", { name: "Recent history" })).toBeNull();
  expect(page.queryByText("Fired")).toBeNull();
  expect(page.queryByText("Canceled")).toBeNull();
});

test("does not load or disclose reminder data to a non-owner", async () => {
  let loaded = false;
  renderReminders({
    owned: false,
    onLoad: async () => {
      loaded = true;
      throw new Error("must not load");
    },
  });
  expect(
    await within(document.body).findByText("Only the Agent owner can view reminders."),
  ).toBeTruthy();
  expect(loaded).toBeFalse();
});

test("empty, private, and error states use one succinct line and errors can be retried", async () => {
  renderReminders({
    onLoad: async () => ({ status: "ready", reminders: [], hasMore: false, cursor: null }),
  });
  const page = within(document.body);
  expect(await page.findByText("No active reminders")).toBeTruthy();
  expect(page.queryByText(/will appear here/)).toBeNull();
  cleanup();

  let attempts = 0;
  renderReminders({
    onLoad: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("offline");
      return { status: "ready", reminders: [], hasMore: false, cursor: null };
    },
  });
  expect((await page.findByRole("alert")).textContent).toContain("Reminders could not be loaded.");
  fireEvent.click(page.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(page.getByText("No active reminders")).toBeTruthy());
  expect(attempts).toBe(2);
});

test("an overdue scheduled reminder remains visible", async () => {
  renderReminders({
    onLoad: async () => ({
      status: "ready",
      reminders: [
        {
          id: "overdue-reminder",
          title: "Overdue review",
          fireAt: "2020-09-11T10:00:00Z",
          repeat: null,
          timezone: "UTC",
          target: "@owner",
          createdAt: "2026-09-09T10:00:00Z",
          anchor: null,
        },
      ],
      hasMore: false,
      cursor: null,
    }),
  });
  const page = within(document.body);
  expect(await page.findByText("Overdue review")).toBeTruthy();
  expect(page.queryByText(/Next:/)).toBeNull();
  expect(page.queryByText(/Fired:/)).toBeNull();
});

test("message links carry the anchor and thread root in search params", async () => {
  renderReminders({
    onLoad: async () => ({
      status: "ready",
      reminders: [
        {
          id: "thread-reminder",
          title: "Thread follow-up",
          fireAt: "2026-09-11T10:00:00Z",
          repeat: null,
          timezone: "UTC",
          target: "#general",
          createdAt: "2026-09-09T10:00:00Z",
          anchor: {
            kind: "channel",
            channelId: "channel-1",
            channelName: "general",
            messageId: "reply-1",
            threadRootId: "root-1",
          },
        },
      ],
      hasMore: false,
      cursor: null,
    }),
  });
  const link = await within(document.body).findByRole("link", { name: /#general.*root-1/ });
  expect(link.getAttribute("href")).toContain("message=reply-1");
  expect(link.getAttribute("href")).toContain("threadRootId=root-1");
  expect(link.getAttribute("href")).toEndWith("#message-reply-1");
});
