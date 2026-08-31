import "./dom-setup";

import { expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";

import { RuntimePopover } from "@/components/runtime-usage";

test("usage scan is on demand and renders a real snapshot", async () => {
  let scans = 0;
  render(
    <RuntimePopover
      runtime={{ provider: "codex", version: "1", displayName: "Custom Codex" }}
      usage={{
        status: "available",
        snapshot: {
          planType: "pro",
          primary: { usedPercent: 42, resetsAt: "2026-09-01T00:00:00Z" },
        },
      }}
      onScan={async () => {
        scans += 1;
      }}
    />,
  );
  fireEvent.click(within(document.body).getByRole("button", { name: /Custom Codex/ }));
  await waitFor(() =>
    expect(within(document.body).getByRole("dialog").textContent).toContain("Plan: pro"),
  );
  fireEvent.click(
    within(within(document.body).getByRole("dialog")).getByRole("button", { name: "Refresh" }),
  );
  await waitFor(() => expect(scans).toBe(1));
  cleanup();
});

test("renders the supplied runtime display name", () => {
  render(
    <RuntimePopover
      runtime={{ provider: "codex", version: "1", displayName: "Future Agent" }}
      onScan={() => undefined}
    />,
  );
  expect(document.body.textContent).toContain("Future Agent");
});
