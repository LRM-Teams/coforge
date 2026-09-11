import "./dom-setup";

import { expect, test } from "bun:test";
import { render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentActivityTimeline } from "@/features/agents/agent-activity-timeline";
import type { ActivityEntry } from "@/features/agents/agent-activity";

function activity(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    launchId: "launch-1",
    clientSeq: 1,
    activityKind: "working",
    detailKind: "tool_started",
    level: "info",
    detail: "src/private.ts",
    observedAtMs: Date.parse("2026-09-08T10:00:00Z"),
    entries: [{ kind: "tool_start", toolName: "read" }],
    ...overrides,
  };
}

test("renders flattened labels, separate tool details, aliases, lineage, and semantic tones", () => {
  render(
    <AgentActivityTimeline
      timeZone="UTC"
      activity={[
        activity({
          clientSeq: 8,
          activityKind: "working",
          detail: "bun test agent",
          entries: [{ kind: "tool_start", toolName: "shell" }],
        }),
        activity({
          clientSeq: 7,
          activityKind: "working",
          detail: "src/private.ts",
          entries: [{ kind: "tool_start", toolName: "read" }],
        }),
        activity({
          clientSeq: 6,
          activityKind: "thinking",
          detail: "ignored",
          entries: [
            {
              kind: "thinking",
              text: "Compare both boundaries",
              subagent: { parentToolUseId: "parent-1" },
            },
          ],
        }),
        activity({
          clientSeq: 5,
          activityKind: "working",
          entries: [{ kind: "text", text: "Finished safely" }],
        }),
        activity({
          clientSeq: 4,
          activityKind: "online",
          detailKind: "idle",
          detail: "Idle",
          entries: [],
        }),
        activity({
          clientSeq: 3,
          activityKind: "error",
          detailKind: "runtime_error",
          level: "error",
          detail: "Runtime failed",
          entries: [],
        }),
        activity({
          clientSeq: 2,
          activityKind: "offline",
          detailKind: "stopped",
          detail: "Stopped",
          entries: [],
        }),
      ]}
    />,
  );

  const rows = within(document.body).getAllByRole("listitem");
  expect(rows).toHaveLength(7);
  expect(rows[0]?.textContent).toContain("Running command");
  expect(rows[0]?.textContent).toContain("bun test agent");
  expect(rows[0]?.querySelector(".font-mono")?.textContent).toBe("bun test agent");
  expect(rows[1]?.textContent).toContain("Reading file");
  expect(rows[1]?.textContent).toContain("src/private.ts");
  expect(rows[2]?.textContent).toContain("Thinking");
  expect(rows[2]?.textContent).toContain("Compare both boundaries");
  expect(rows[2]?.textContent).toContain("Subagent");
  expect(rows[3]?.textContent).toContain("Output");
  expect(rows[3]?.textContent).toContain("Finished safely");
  expect(rows[4]?.querySelector(".bg-success-solid")).not.toBeNull();
  expect(rows[5]?.querySelector(".bg-error-solid")).not.toBeNull();
  expect(rows[6]?.querySelector(".bg-offline")).not.toBeNull();
  expect(rows[0]?.querySelector(".bg-amber-500")).not.toBeNull();
  expect(rows[2]?.querySelector(".bg-amber-500")).not.toBeNull();
  expect(rows[3]?.querySelector(".bg-cyan-500")).not.toBeNull();
});

test("long thinking and output are literal collapsed text expandable by accessible buttons", async () => {
  const user = userEvent.setup();
  const thinking = `<strong>not markup</strong>${" think".repeat(40)}`;
  const output = `<script>window.bad = true</script>${" output".repeat(40)}`;
  render(
    <AgentActivityTimeline
      timeZone={null}
      activity={[
        activity({
          clientSeq: 2,
          activityKind: "thinking",
          entries: [{ kind: "thinking", text: thinking }],
        }),
        activity({ clientSeq: 1, entries: [{ kind: "text", text: output }] }),
      ]}
    />,
  );

  const thinkingButton = within(document.body).getByRole("button", { name: "Thinking" });
  const outputButton = within(document.body).getByRole("button", { name: "Output" });
  expect(thinkingButton.getAttribute("aria-expanded")).toBe("false");
  expect(outputButton.getAttribute("aria-expanded")).toBe("false");
  expect(document.body.querySelector("strong")).toBeNull();
  expect(document.body.querySelector("script")).toBeNull();
  expect(document.body.textContent).toContain("<strong>not markup</strong>");
  expect(document.body.textContent).toContain("<script>window.bad = true</script>");
  await user.click(thinkingButton);
  await user.click(outputButton);
  expect(thinkingButton.getAttribute("aria-expanded")).toBe("true");
  expect(outputButton.getAttribute("aria-expanded")).toBe("true");
  expect(
    document
      .getElementById(thinkingButton.getAttribute("aria-controls")!)
      ?.classList.contains("line-clamp-2"),
  ).toBe(false);
  expect(
    document
      .getElementById(outputButton.getAttribute("aria-controls")!)
      ?.classList.contains("line-clamp-2"),
  ).toBe(false);
});

test("shows the empty state when every activity entry is filtered", () => {
  render(
    <AgentActivityTimeline
      timeZone={null}
      activity={[activity({ entries: [{ kind: "tool_start", toolName: "send_message" }] })]}
    />,
  );
  expect(within(document.body).queryByRole("list", { name: "Activity timeline" })).toBeNull();
  expect(document.body.textContent).toContain("No Activity yet");
});
