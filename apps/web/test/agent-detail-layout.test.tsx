import "./dom-setup";

import { expect, test } from "bun:test";
import { RouterContextProvider } from "@tanstack/react-router";
import { render, within } from "@testing-library/react";

import { AgentDetail } from "@/features/agents/agent-detail";
import { getRouter } from "@/router";

const activity = Array.from({ length: 40 }, (_, index) => ({
  computerId: "computer-1",
  launchId: "launch-1",
  clientSeq: 40 - index,
  detailKind: "tool_started",
  level: "info" as const,
  detail: `Activity ${40 - index}`,
  observedAtMs: Date.UTC(2026, 8, 7, 12, index),
}));

const detail = {
  id: "agent-1",
  workspaceId: "workspace-1",
  name: "builder",
  displayName: "Builder",
  description: "Builds the product",
  createdAt: new Date("2026-09-07T00:00:00.000Z"),
  computerId: "computer-1",
  owner: { id: "owner-1", username: "alice" },
  runtimeConfig: {
    runtime: "codex" as const,
    provider: { kind: "default" as const },
    model: "gpt-5",
    modelProvider: "",
    reasoning: "high",
  },
  computer: { id: "computer-1", label: "computer-1" },
  latestError: undefined,
  activity,
  status: { value: "active" as const, expiresAt: null, ordering: null },
  ownedByCurrentUser: false,
  runtimeCredential: null,
};

test("keeps the Agent heading and tabs outside the long Activity scroll region", () => {
  render(
    <RouterContextProvider router={getRouter()}>
      <AgentDetail
        detail={detail}
        tab="activity"
        timeZone="UTC"
        onSaveRuntimeCredential={async () => undefined}
        onDeleteRuntimeCredential={async () => undefined}
        onUpdate={async () => undefined}
        onLoadRuntimeOptions={async () => ({ providers: [], catalogs: [] })}
      />
    </RouterContextProvider>,
  );
  const page = within(document.body);
  const main = page.getByRole("main");
  const tabs = page.getByRole("navigation", { name: "Agent details" });
  const activityRegion = page.getByRole("region", { name: "Activity" });

  expect(main.className).toContain("h-svh");
  expect(main.className).toContain("max-h-svh");
  expect(main.className).toContain("overflow-hidden");
  expect(activityRegion.className).toContain("overflow-y-auto");
  expect(activityRegion.contains(tabs)).toBe(false);
  expect(activityRegion.contains(page.getByRole("heading", { name: "Builder" }))).toBe(false);
  expect(within(activityRegion).getAllByRole("listitem")).toHaveLength(40);
});

test("shows Error and the original message without internal error metadata", () => {
  const view = render(
    <RouterContextProvider router={getRouter()}>
      <AgentDetail
        detail={{
          ...detail,
          activity: [
            {
              ...activity[0]!,
              detailKind: "runtime_error",
              level: "error",
              detail: "request timed out: Bearer fixture-private-token",
              runtimeError: {
                errorClass: "CodexTurnError",
                errorReason: "turn_retrying",
                fingerprint: "12345678",
              },
            },
          ],
        }}
        tab="activity"
        timeZone="UTC"
        onSaveRuntimeCredential={async () => undefined}
        onDeleteRuntimeCredential={async () => undefined}
        onUpdate={async () => undefined}
        onLoadRuntimeOptions={async () => ({ providers: [], catalogs: [] })}
      />
    </RouterContextProvider>,
  );
  const row = within(view.getByRole("region", { name: "Activity" })).getByRole("listitem");
  expect(within(row).getByText("Error")).toBeTruthy();
  expect(within(row).getByText("request timed out: Bearer fixture-private-token")).toBeTruthy();
  expect(row.textContent).not.toContain("Retrying:");
  expect(row.textContent).not.toContain("turn_retrying");
  expect(row.textContent).not.toContain("CodexTurnError");
});
