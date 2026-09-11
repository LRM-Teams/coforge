import "./dom-setup";

import { expect, test } from "bun:test";
import { fireEvent, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentActivityAvatar } from "@/features/agents/agent-activity-avatar";
import type { AgentDisplaySnapshot } from "@coforge/protocol/agent-display";

function display(overrides: Partial<AgentDisplaySnapshot> = {}): AgentDisplaySnapshot {
  return {
    protocolMajor: 1,
    workspaceId: "workspace-1",
    computerId: "computer-1",
    agentId: "agent-1",
    revision: 1,
    activityKind: "working",
    detailKind: "model_request_started",
    detail: "Cloud-approved work",
    entries: [],
    expiresAt: 99_000,
    ...overrides,
  };
}

const busyHistory = [
  {
    launchId: "launch-old",
    clientSeq: 1,
    activityKind: "working" as const,
    detailKind: "running_command",
    level: "info",
    detail: "private command",
    observedAtMs: 1,
  },
];

test("changes current state only when a new cloud display revision is rendered", () => {
  const view = render(
    <AgentActivityAvatar
      agent={{ name: "dax", displayName: "Dax" }}
      display={display({
        activityKind: "online",
        detailKind: "model_request_started",
        detail: "conflicting raw work",
      })}
      activity={busyHistory}
    />,
  );
  let trigger = within(document.body).getByRole("button", { name: /Dax, Online/ });
  expect(trigger.getAttribute("data-working")).toBe("false");
  expect(trigger.querySelector(".bg-success-solid")).not.toBeNull();

  view.rerender(
    <AgentActivityAvatar
      agent={{ name: "dax", displayName: "Dax" }}
      display={display({
        revision: 2,
        activityKind: "working",
        detailKind: "future_kind",
        detail: "Backend customized work",
      })}
      activity={busyHistory}
    />,
  );
  trigger = within(document.body).getByRole("button", { name: /Dax, Backend customized work/ });
  expect(trigger.getAttribute("data-working")).toBe("true");
  expect(trigger.querySelector(".bg-amber-500")).not.toBeNull();
  expect(trigger.innerHTML).toContain("animate-pulse");
});

test.each([
  [undefined, "Status unknown"],
  [
    display({
      activityKind: "offline",
      detailKind: "model_response_started",
      detail: "stale work",
      expiresAt: null,
    }),
    "Offline",
  ],
] as const)(
  "unknown and offline cloud displays never infer work from busy history",
  (current, label) => {
    render(
      <AgentActivityAvatar
        agent={{ name: "dax", displayName: "Dax" }}
        display={current}
        activity={busyHistory}
      />,
    );
    const trigger = within(document.body).getByRole("button", {
      name: new RegExp(`Dax, ${label}`),
    });
    expect(trigger.getAttribute("data-working")).toBe("false");
    expect(trigger.innerHTML).not.toContain("animate-pulse");
  },
);

test("error and loading history do not erase the cloud current state", async () => {
  render(
    <AgentActivityAvatar
      agent={{ name: "dax", displayName: "Dax" }}
      display={display({
        activityKind: "error",
        detailKind: "runtime_error",
        detail: "Provider failed",
      })}
      activity={busyHistory}
      loading
      error
    />,
  );
  const trigger = within(document.body).getByRole("button", {
    name: /Dax, Error: Provider failed/,
  });
  expect(trigger.getAttribute("data-working")).toBe("false");
  expect(trigger.querySelector(".bg-error-solid")).not.toBeNull();
  fireEvent.click(trigger);
  const popup = await within(document.body).findByRole("dialog");
  expect(popup.textContent).toContain("Error: Provider failed");
  expect(popup.textContent).toContain("Loading activity");
});

test("keyboard recent list filters before limiting, hides tool detail, and preserves literal text", async () => {
  const user = userEvent.setup();
  const activity = [
    {
      launchId: "launch-1",
      clientSeq: 8,
      activityKind: "working" as const,
      detailKind: "tool_started",
      level: "info",
      detail: "secret recipient",
      observedAtMs: Date.parse("2026-09-07T07:18:30Z"),
      entries: [{ kind: "tool_start" as const, toolName: "send_message" }],
    },
    {
      launchId: "launch-1",
      clientSeq: 7,
      activityKind: "thinking" as const,
      detailKind: "thinking_started",
      level: "info",
      detail: "ignored",
      observedAtMs: Date.parse("2026-09-07T07:18:29Z"),
      entries: [
        { kind: "thinking" as const, text: "<b>literal thought</b>" },
        { kind: "text" as const, text: "literal output" },
      ],
    },
    ...Array.from({ length: 4 }, (_, index) => ({
      launchId: "launch-1",
      clientSeq: 6 - index,
      activityKind: "working" as const,
      detailKind: "tool_started",
      level: "info",
      detail: `private/path-${index}`,
      observedAtMs: Date.parse(`2026-09-07T07:18:${28 - index}Z`),
      entries: [{ kind: "tool_start" as const, toolName: index === 0 ? "shell" : "read_file" }],
    })),
  ];
  render(
    <AgentActivityAvatar
      agent={{ name: "dax", displayName: "Dax" }}
      display={display({ activityKind: "thinking", detail: "Cloud is thinking" })}
      timeZone="Asia/Shanghai"
      activity={activity}
    />,
  );
  await user.tab();
  await user.keyboard("{Enter}");
  const popup = await within(document.body).findByRole("dialog");
  const items = within(popup).getAllByRole("listitem");
  expect(items).toHaveLength(5);
  expect(items.map((item) => item.textContent)).toEqual([
    expect.stringContaining("<b>literal thought</b>"),
    expect.stringContaining("literal output"),
    expect.stringContaining("Running command"),
    expect.stringContaining("Reading file"),
    expect.stringContaining("Reading file"),
  ]);
  expect(popup.querySelector("b")).toBeNull();
  expect(popup.textContent).not.toContain("secret recipient");
  expect(popup.textContent).not.toContain("private/path");
  expect(popup.querySelector("time")?.textContent).toBe("15:18:29");
  expect(within(popup).queryByRole("button")).toBeNull();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(within(document.body).queryByRole("dialog")).toBeNull());
});
