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

test("confirms a copy for a moment instead of staying copied", async () => {
  const written: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (value: string) => void written.push(value) },
  });
  render(<ComputerDetail computer={computer} onScanUsage={async () => undefined} />);
  const page = within(document.body);

  fireEvent.click(page.getByRole("button", { name: "Copy machine ID" }));
  await waitFor(() => expect(written).toEqual(["macos:9f2c"]));
  await waitFor(() => expect(page.getByRole("button", { name: "Machine ID copied" })).toBeTruthy());
  await waitFor(() => expect(page.getByRole("button", { name: "Copy machine ID" })).toBeTruthy(), {
    timeout: 4000,
  });
});

test("leaves the machine id readable when the clipboard refuses", async () => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async () => {
        throw new Error("not allowed in an insecure context");
      },
    },
  });
  render(<ComputerDetail computer={computer} onScanUsage={async () => undefined} />);
  const page = within(document.body);

  fireEvent.click(page.getByRole("button", { name: "Copy machine ID" }));
  await waitFor(() => expect(page.getByRole("button", { name: "Copy machine ID" })).toBeTruthy());
  expect(page.getByText("macos:9f2c")).toBeTruthy();
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
