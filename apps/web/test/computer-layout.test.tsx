import "./dom-setup";

import { afterEach, expect, test } from "bun:test";
import { RouterContextProvider } from "@tanstack/react-router";
import { cleanup, render, within } from "@testing-library/react";

import { ComputerLayout } from "@/features/computers/computer-layout";
import { ComputerNotFound } from "@/features/computers/computer-not-found";
import { getRouter } from "@/router";

afterEach(cleanup);

const computer = { id: "computer-1", machineId: "macos:9f2c", kind: "local", online: true };

function renderLayout(computers = [computer], selectedComputerId?: string) {
  render(
    <RouterContextProvider router={getRouter()}>
      <ComputerLayout
        computers={computers}
        selectedComputerId={selectedComputerId}
        onAdd={() => undefined}
      >
        <p>Computer detail</p>
      </ComputerLayout>
    </RouterContextProvider>,
  );
  return within(document.body);
}

test("lists each Computer as a typed detail link and marks the selected one", () => {
  const page = renderLayout(
    [computer, { id: "computer-2", machineId: "linux:41ab", kind: "local", online: false }],
    computer.id,
  );

  expect(page.getByRole("navigation", { name: "Connected computers" })).toBeTruthy();
  expect(page.getByText("macos:9f2c")).toBeTruthy();
  expect(page.getByText("Linux")).toBeTruthy();

  const selected = page.getByRole("link", { name: /macos:9f2c/ });
  expect(selected.getAttribute("href")).toBe("/en/computers/computer-1");
  expect(selected.getAttribute("aria-current")).toBe("page");
  expect(page.getByRole("link", { name: /linux:41ab/ }).getAttribute("aria-current")).toBeNull();
  expect(page.getByText("Computer detail")).toBeTruthy();
});

test("says a computer is not in this workspace instead of a bare Not Found", () => {
  render(
    <RouterContextProvider router={getRouter()}>
      <ComputerLayout computers={[computer]} selectedComputerId="missing" onAdd={() => undefined}>
        <ComputerNotFound />
      </ComputerLayout>
    </RouterContextProvider>,
  );
  const page = within(document.body);

  expect(
    page.getByRole("heading", { name: "This computer is not in this workspace" }),
  ).toBeTruthy();
  expect(document.body.textContent).toContain("It may have been removed");
  expect(document.body.textContent).not.toContain("Not Found");
  // The list is still there, so the miss is recoverable without the back button.
  expect(page.getByRole("link", { name: /macos:9f2c/ })).toBeTruthy();
});

test("offers the install path instead of a detail panel when no Computer is connected", () => {
  const page = renderLayout([]);

  expect(page.getByText("No computers connected")).toBeTruthy();
  expect(page.getAllByRole("button", { name: "Add computer" }).length).toBe(2);
  expect(page.queryByText("Computer detail")).toBeNull();
  expect(page.queryByRole("link")).toBeNull();
});
