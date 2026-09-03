import "./dom-setup";

import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";

import { ComputerDetail } from "@/features/computers/computer-detail";

afterEach(cleanup);

const computer = {
  id: "computer-1",
  machineId: "macos:9f2c",
  kind: "local",
  online: true,
  connectedAt: "2026-08-31T10:00:00.000Z",
  runtimes: [
    {
      provider: "codex" as const,
      displayName: "Codex Runtime",
      version: "0.151.0",
      observedAt: "2026-08-31T10:00:00.000Z",
    },
  ],
  modelCatalogs: [{ provider: "codex", models: [{ id: "gpt-5", displayName: "GPT-5" }] }],
};

test("shows the machine, its Code Agents, and an explicit no-snapshot usage state", () => {
  render(<ComputerDetail computer={computer} onScanUsage={async () => undefined} />);
  const page = within(document.body);

  expect(page.getByRole("heading", { name: "macOS" })).toBeTruthy();
  expect(page.getByText("Online")).toBeTruthy();
  expect(page.getByText("macos:9f2c")).toBeTruthy();
  expect(page.getByText("Codex Runtime")).toBeTruthy();
  expect(document.body.textContent).toContain("Version 0.151.0");
  expect(page.getByText("GPT-5")).toBeTruthy();
  expect(page.getByText("No snapshot yet")).toBeTruthy();
});

test("scans usage for the runtime the User asked about", async () => {
  const scanned: string[] = [];
  render(
    <ComputerDetail
      computer={computer}
      onScanUsage={async (provider) => {
        scanned.push(provider);
      }}
    />,
  );

  fireEvent.click(within(document.body).getByRole("button", { name: "Scan" }));
  await waitFor(() => expect(scanned).toEqual(["codex"]));
});
