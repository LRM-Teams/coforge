import "./dom-setup";

import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentActivityAvatar } from "@/features/agents/agent-activity-avatar";

afterEach(cleanup);

test("opens recent activity from the avatar without exposing command details", async () => {
  const page = within(document.body);
  render(
    <AgentActivityAvatar
      agent={{ name: "dax", displayName: "Dax" }}
      status="active"
      activity={[
        {
          id: "new",
          activity: "running_command",
          level: "info",
          message: "private command",
          occurredAt: new Date(),
        },
        {
          id: "old",
          activity: "reading_file",
          level: "info",
          message: "private path",
          occurredAt: new Date(Date.now() - 10_000),
        },
      ]}
    />,
  );
  const trigger = page.getByRole("button", { name: /Dax.*Running command/ });
  expect(trigger.getAttribute("data-working")).toBe("true");
  expect(trigger.querySelector("canvas")).toBeNull();
  expect(trigger.textContent).toBe("D");
  expect(trigger.querySelector(".bg-amber-500")).not.toBeNull();
  expect(
    trigger.querySelector(".bg-amber-500")?.classList.contains("motion-safe:animate-pulse"),
  ).toBe(true);
  fireEvent.click(trigger);
  const popup = await page.findByRole("dialog");
  expect(
    within(popup)
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual([expect.stringContaining("Running command"), expect.stringContaining("Reading file")]);
  expect(popup.textContent).not.toContain("private command");
  expect(popup.textContent).not.toContain("private path");
});

test.each([
  ["active", "turn_completed", "info", 0],
  ["active", "idle", "info", 0],
  ["inactive", "running_command", "info", 0],
  ["active", "running_command", "info", 180_000],
  ["active", "running_command", "error", 0],
  ["active", "message_received", "info", 0],
] as const)("does not animate %s / %s / %s / %s", (status, activity, level, age) => {
  render(
    <AgentActivityAvatar
      agent={{ name: "dax", displayName: "Dax" }}
      status={status}
      activity={[{ activity, level, occurredAt: new Date(Date.now() - age), message: "" }]}
    />,
  );
  const trigger = within(document.body).getByRole("button", { name: /Dax/ });
  expect(trigger.getAttribute("data-working")).toBe("false");
  expect(trigger.querySelector("canvas")).toBeNull();
  expect(trigger.querySelector(".bg-amber-500")).toBeNull();
  expect(trigger.innerHTML).not.toContain("animate-pulse");
});

test("expires the working observation while the page stays open", async () => {
  render(
    <AgentActivityAvatar
      agent={{ name: "dax", displayName: "Dax" }}
      status="active"
      activity={[
        {
          activity: "working",
          level: "info",
          occurredAt: new Date(Date.now() - 59_000),
          message: "",
        },
      ]}
    />,
  );
  const trigger = within(document.body).getByRole("button", { name: /Dax/ });
  expect(trigger.getAttribute("data-working")).toBe("true");
  await waitFor(() => expect(trigger.getAttribute("data-working")).toBe("false"), {
    timeout: 2_000,
  });
  expect(trigger.querySelector("canvas")).toBeNull();
  fireEvent.click(trigger);
  const popup = await within(document.body).findByRole("dialog");
  expect(popup.textContent).not.toContain("updated");
  expect(trigger.getAttribute("aria-label")).not.toContain("updated");
});

test("keyboard opens a compact time-and-activity list without icons or footer actions", async () => {
  const user = userEvent.setup();
  render(
    <AgentActivityAvatar
      agent={{ name: "dax", displayName: "Dax" }}
      status="active"
      timeZone="Asia/Shanghai"
      activity={Array.from({ length: 8 }, (_, i) => ({
        id: String(i),
        activity: "reading_file",
        level: "info",
        message: "",
        occurredAt: new Date(`2026-09-07T07:18:${30 - i}Z`),
      }))}
    />,
  );
  await user.tab();
  await user.keyboard("{Enter}");
  const popup = await within(document.body).findByRole("dialog");
  expect(within(popup).getAllByRole("listitem")).toHaveLength(5);
  expect(popup.querySelector("time")?.textContent).toBe("15:18:30");
  expect(popup.querySelector("svg")).toBeNull();
  expect(within(popup).queryByRole("button")).toBeNull();
  expect(popup.textContent).not.toContain("updated");
  expect(popup.textContent).not.toContain("View all");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(within(document.body).queryByRole("dialog")).toBeNull());
});
