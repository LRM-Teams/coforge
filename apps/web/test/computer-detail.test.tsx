import "./dom-setup";

import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";

import { ComputerDetail, CopyMachineId } from "@/features/computers/computer-detail";

const nativeClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

afterEach(() => {
  cleanup();
  // The stub is installed on the shared navigator, so it would otherwise
  // outlive this file and reach every test that runs after it.
  if (nativeClipboard) Object.defineProperty(navigator, "clipboard", nativeClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

/** Records what the page put on the clipboard, for the life of one test. */
function stubClipboard() {
  const written: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (value: string) => void written.push(value) },
  });
  return written;
}

const computer = {
  id: "computer-1",
  machineId: "macos:9f2c",
  kind: "local",
  ownedByCurrentUser: true,
  online: true,
  connectedAt: "2026-08-31T10:00:00.000Z",
  runtimes: [
    {
      id: "runtime-1",
      provider: "codex" as const,
      displayName: "Codex Runtime",
      version: "0.151.0",
      observedAt: "2026-08-31T10:00:00.000Z",
      isPublic: false,
    },
  ],
  modelCatalogs: [{ provider: "codex", models: [{ id: "gpt-5", displayName: "GPT-5" }] }],
};

test("shows the machine, its Code Agents, and an explicit no-snapshot usage state", () => {
  render(
    <ComputerDetail
      computer={computer}
      onScanUsage={async () => undefined}
      onSetRuntimePublic={async () => undefined}
    />,
  );
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
  const written = stubClipboard();
  render(<CopyMachineId machineId="macos:9f2c" feedbackMs={30} />);
  const page = within(document.body);

  fireEvent.click(page.getByRole("button", { name: "Copy machine ID" }));

  await waitFor(() => expect(written).toEqual(["macos:9f2c"]));
  await waitFor(() => expect(page.getByRole("button", { name: "Machine ID copied" })).toBeTruthy());
  await waitFor(() => expect(page.getByRole("button", { name: "Copy machine ID" })).toBeTruthy());
});

test("gives a second press its own full confirmation", async () => {
  stubClipboard();
  render(<CopyMachineId machineId="macos:9f2c" feedbackMs={80} />);
  const page = within(document.body);
  const pressAndConfirm = async () => {
    fireEvent.click(page.getByRole("button", { name: /machine ID/i }));
    await waitFor(() =>
      expect(page.getByRole("button", { name: "Machine ID copied" })).toBeTruthy(),
    );
  };

  await pressAndConfirm();
  await new Promise((resolve) => setTimeout(resolve, 60));
  // The first press's window is nearly spent; the second must start a new one
  // rather than inherit what is left of it.
  await pressAndConfirm();
  await new Promise((resolve) => setTimeout(resolve, 40));

  expect(page.getByRole("button", { name: "Machine ID copied" })).toBeTruthy();
});

test("leaves the machine id readable when the clipboard refuses", async () => {
  let refusals = 0;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async () => {
        refusals += 1;
        throw new Error("not allowed in an insecure context");
      },
    },
  });
  render(
    <ComputerDetail
      computer={computer}
      onScanUsage={async () => undefined}
      onSetRuntimePublic={async () => undefined}
    />,
  );
  const page = within(document.body);

  fireEvent.click(page.getByRole("button", { name: "Copy machine ID" }));

  // Wait for the refusal to have been handled before asserting, or the button
  // would still be showing its initial state and the assertion would pass on a
  // component that wrongly claims it copied.
  await waitFor(() => expect(refusals).toBe(1));
  expect(page.queryByRole("button", { name: "Machine ID copied" })).toBeNull();
  expect(page.getByRole("button", { name: "Copy machine ID" })).toBeTruthy();
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
      onSetRuntimePublic={async () => undefined}
    />,
  );

  fireEvent.click(within(document.body).getByRole("button", { name: "Scan" }));
  await waitFor(() => expect(scanned).toEqual(["codex"]));
});

test("allows the Computer owner to publish a private runtime", async () => {
  const setPublic = mock(async () => undefined);
  render(
    <ComputerDetail
      computer={computer}
      onScanUsage={async () => undefined}
      onSetRuntimePublic={setPublic}
    />,
  );

  fireEvent.click(within(document.body).getByRole("button", { name: "Publish Codex Runtime" }));
  await waitFor(() => expect(setPublic).toHaveBeenCalledWith("runtime-1", true));
});

test("does not expose owner-only runtime controls on a shared Computer", () => {
  render(
    <ComputerDetail
      computer={{
        ...computer,
        ownedByCurrentUser: false,
        runtimes: [{ ...computer.runtimes[0]!, isPublic: true }],
      }}
      onScanUsage={async () => undefined}
      onSetRuntimePublic={async () => undefined}
    />,
  );

  const page = within(document.body);
  expect(page.getByText("Codex Runtime")).toBeTruthy();
  expect(page.queryByRole("button", { name: "Scan" })).toBeNull();
  expect(page.queryByRole("button", { name: /private/i })).toBeNull();
});
