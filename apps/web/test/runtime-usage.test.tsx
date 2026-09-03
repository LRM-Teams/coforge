import "./dom-setup";

import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";

import { RuntimeUsage } from "@/features/computers/runtime-usage";

afterEach(cleanup);

const codex = { provider: "codex" as const, version: "1", displayName: "Custom Codex" };

test("usage scan is on demand and renders a real snapshot", async () => {
  let scans = 0;
  render(
    <RuntimeUsage
      runtime={codex}
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
  const page = within(document.body);

  expect(document.body.textContent).toContain("Pro");
  expect(document.body.textContent).toContain("Session");
  expect(document.body.textContent).toContain("42% used");
  expect(page.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("42");

  fireEvent.click(page.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(scans).toBe(1));
});

test("renders a Claude rate-limit observation without inventing a percentage", () => {
  render(
    <RuntimeUsage
      runtime={{ provider: "claude-code", version: "1", displayName: "Claude Code" }}
      usage={{
        status: "available",
        snapshot: { primary: { status: "rate-limited", resetsAt: "2026-09-04T03:00:00.000Z" } },
      }}
      onScan={() => undefined}
    />,
  );

  expect(document.body.textContent).toContain("Limit reached");
  expect(document.body.textContent).not.toContain("% used");
  expect(within(document.body).queryByRole("progressbar")).toBeNull();
});

test("names the runtime and offers a first scan when there is no snapshot", () => {
  render(
    <RuntimeUsage
      runtime={{ provider: "codex", version: "1", displayName: "Future Agent" }}
      onScan={() => undefined}
    />,
  );

  expect(document.body.textContent).toContain("Future Agent");
  expect(document.body.textContent).toContain("No snapshot yet");
  expect(within(document.body).getByRole("button", { name: "Scan" })).toBeTruthy();
});

test("reports a status the Computer could not answer in the User's language", () => {
  render(
    <RuntimeUsage runtime={codex} usage={{ status: "unsupported" }} onScan={() => undefined} />,
  );

  expect(document.body.textContent).toContain("This Code Agent does not report usage");
});
