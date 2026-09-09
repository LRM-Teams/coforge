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
              title: "Review launch notes",
              status: "scheduled",
              fireAt: "2026-09-10T10:00:00Z",
              firedAt: null,
              repeat: "FREQ=DAILY",
              timezone: "UTC",
              createdAt: "2026-09-09T10:00:00Z",
              anchor: null,
            },
          ],
          hasMore: false,
          cursor: null,
        })}
        onLoadHistory={async () => ({
          status: "ready",
          events: [
            {
              id: "event-1",
              type: "created",
              title: "Review launch notes",
              time: "2026-09-09T10:00:00Z",
              scheduledFor: "2026-09-10T10:00:00Z",
              nextFireAt: "2026-09-10T10:00:00Z",
            },
          ],
        })}
        {...props}
      />
    ),
  });
  const router = createRouter({ routeTree: root });
  render(<RouterProvider router={router} />);
}

test("renders reminder summary and expands recent history", async () => {
  renderReminders();
  const page = within(document.body);
  expect(await page.findByText("Review launch notes")).toBeTruthy();
  expect(page.getByText("Scheduled")).toBeTruthy();
  expect(page.getByText(/FREQ=DAILY/)).toBeTruthy();
  fireEvent.click(page.getByRole("button", { name: "Recent history" }));
  await waitFor(() => expect(page.getByText(/Created · Review launch notes/)).toBeTruthy());
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
  expect(await within(document.body).findByText("Reminders are private")).toBeTruthy();
  expect(loaded).toBeFalse();
});

test("canceled reminders show their scheduled time, never a fabricated fired time", async () => {
  renderReminders({
    onLoad: async () => ({
      status: "ready",
      reminders: [
        {
          id: "canceled-reminder",
          title: "Canceled review",
          status: "canceled",
          fireAt: "2026-09-11T10:00:00Z",
          firedAt: null,
          repeat: null,
          timezone: "UTC",
          createdAt: "2026-09-09T10:00:00Z",
          anchor: null,
        },
      ],
      hasMore: false,
      cursor: null,
    }),
  });
  const page = within(document.body);
  expect(await page.findByText("Canceled review")).toBeTruthy();
  expect(page.getByText(/Scheduled for:/)).toBeTruthy();
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
          status: "scheduled",
          fireAt: "2026-09-11T10:00:00Z",
          firedAt: null,
          repeat: null,
          timezone: "UTC",
          createdAt: "2026-09-09T10:00:00Z",
          anchor: {
            kind: "channel",
            channelId: "channel-1",
            messageId: "reply-1",
            threadRootId: "root-1",
          },
        },
      ],
      hasMore: false,
      cursor: null,
    }),
  });
  const link = await within(document.body).findByRole("link", { name: "View message" });
  expect(link.getAttribute("href")).toContain("message=reply-1");
  expect(link.getAttribute("href")).toContain("threadRootId=root-1");
  expect(link.getAttribute("href")).toEndWith("#message-reply-1");
});
