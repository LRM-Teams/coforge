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
  await waitFor(() => {
    const dialog = within(document.body).getByRole("dialog");
    expect(dialog.textContent).toContain("Pro plan");
    expect(dialog.textContent).toContain("Session");
    expect(dialog.textContent).toContain("42% used");
    expect(within(dialog).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("42");
  });
  fireEvent.click(
    within(within(document.body).getByRole("dialog")).getByRole("button", { name: "Refresh" }),
  );
  await waitFor(() => expect(scans).toBe(1));
  cleanup();
});

test("renders a Claude rate-limit observation without inventing a percentage", async () => {
  render(
    <RuntimePopover
      runtime={{ provider: "claude-code", version: "1", displayName: "Claude Code" }}
      usage={{
        status: "available",
        snapshot: {
          primary: {
            status: "rate-limited",
            resetsAt: "2026-09-04T03:00:00.000Z",
          },
        },
      }}
      onScan={() => undefined}
    />,
  );
  fireEvent.click(within(document.body).getByRole("button", { name: /Claude Code/ }));
  await waitFor(() => {
    const text = within(document.body).getByRole("dialog").textContent;
    expect(text).toContain("Limit reached");
    expect(text).not.toContain("% used");
  });
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
