import "./dom-setup";

import { afterEach, expect, test } from "bun:test";
import { RouterContextProvider } from "@tanstack/react-router";
import { cleanup, render, within } from "@testing-library/react";

import { ComputerLayout } from "@/features/computers/computer-layout";
import { ComputerNotFound } from "@/features/computers/computer-not-found";
import { getRouter } from "@/router";

afterEach(cleanup);

const computer = {
  id: "computer-1",
  name: "franks-macbook-pro",
  displayName: "Frank’s MacBook Pro",
  machineId: "macos:9f2c",
  kind: "local",
  online: true,
  computerVersion: "4.5.6",
};

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
    [
      computer,
      {
        id: "computer-2",
        name: "build-box",
        displayName: "Build Box",
        machineId: "linux:41ab",
        kind: "local",
        online: false,
        computerVersion: "",
      },
    ],
    computer.id,
  );

  expect(page.getByRole("navigation", { name: "Connected computers" })).toBeTruthy();
  expect(page.getByText("Frank’s MacBook Pro")).toBeTruthy();
  expect(page.queryByText("franks-macbook-pro")).toBeNull();
  expect(page.queryByText("build-box")).toBeNull();
  expect(document.body.textContent).not.toContain("macos:9f2c");
  expect(document.body.textContent).not.toContain("linux:41ab");

  const selected = page.getByRole("link", { name: /Frank’s MacBook Pro/ });
  expect(selected.getAttribute("href")).toBe("/en/computers/computer-1");
  expect(selected.getAttribute("aria-current")).toBe("page");
  expect(within(selected).getByText("v4.5.6")).toBeTruthy();
  expect(page.queryByText("Unknown")).toBeNull();
  expect(within(selected).getByText("Online")).toBeTruthy();
  expect(within(page.getByRole("link", { name: /Build Box/ })).getByText("Offline")).toBeTruthy();
  expect(page.getByRole("link", { name: /Build Box/ }).getAttribute("aria-current")).toBeNull();
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
    page.getByRole("heading", {
      name: "This computer is not in this workspace",
    }),
  ).toBeTruthy();
  expect(document.body.textContent).toContain("It may have been removed");
  expect(document.body.textContent).not.toContain("Not Found");
  // The list is still there, so the miss is recoverable without the back button.
  expect(page.getByRole("link", { name: /Frank’s MacBook Pro/ })).toBeTruthy();
});

test("offers the install path instead of a detail panel when no Computer is connected", () => {
  const page = renderLayout([]);

  expect(page.getByText("No computers connected")).toBeTruthy();
  expect(page.getAllByRole("button", { name: "Add computer" }).length).toBe(2);
  expect(page.queryByText("Computer detail")).toBeNull();
  expect(page.queryByRole("link")).toBeNull();
});
