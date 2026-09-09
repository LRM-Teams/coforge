import "./dom-setup";
import { afterEach, expect, test } from "bun:test";
import { cleanup, render, within } from "@testing-library/react";
import { ReminderNotice, type ReminderNoticeView } from "@/features/conversations/reminder-notice";

afterEach(cleanup);

const scheduled: ReminderNoticeView = {
  id: "created-1",
  type: "created",
  title: "Review launch notes",
  time: "2026-09-08T10:00:00Z",
  nextFireAt: "2026-09-09T10:00:00Z",
  ownerAgentName: "River",
  messageId: "message-1",
};

test("renders no reminder UI for an empty notice list", () => {
  const { container } = render(<ol>{[].map((notice) => notice)}</ol>);
  expect(container.querySelector("[data-reminder-notice]")).toBeNull();
});

test("renders scheduled and fired notices as neutral system events with anchor links", () => {
  render(
    <ol>
      <ReminderNotice notice={scheduled} />
      <ReminderNotice notice={{ ...scheduled, id: "fired-1", type: "fired", nextFireAt: null }} />
    </ol>,
  );
  const page = within(document.body);
  expect(page.getAllByText("SYSTEM REMINDER")).toHaveLength(2);
  expect(page.getByText("Reminder scheduled")).toBeTruthy();
  expect(page.getByText("Reminder fired")).toBeTruthy();
  expect(page.getAllByText("Review launch notes")).toHaveLength(2);
  expect(page.getAllByText("River")).toHaveLength(2);
  for (const link of page.getAllByRole("link", { name: "View original message" })) {
    expect(link.getAttribute("href")).toBe("#message-message-1");
  }
  expect(document.querySelector('[data-message="own"]')).toBeNull();
  expect(document.querySelector('[data-message="other"]')).toBeNull();
});
