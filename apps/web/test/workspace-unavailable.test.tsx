import "./dom-setup";

import { expect, test } from "bun:test";
import { RouterContextProvider } from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";

import { AppError } from "@/lib/app-error";
import { PageLoadError } from "@/features/errors/page-load-error";
import { getRouter } from "@/router";

function renderError(error: unknown) {
  render(
    <RouterContextProvider router={getRouter()}>
      <PageLoadError error={error} />
    </RouterContextProvider>,
  );
}

test("a missing Workspace membership is an empty state, not a generic crash", () => {
  renderError(new AppError("WORKSPACE_REQUIRED"));
  expect(document.body.textContent).toContain("No Workspace yet");
  expect(document.body.textContent).toContain("Sign out");
  expect(document.body.textContent).not.toContain("Something went wrong");
  cleanup();
});

test("an unexpected page error stays local and never renders internal details", () => {
  renderError(
    new Error(
      "Invalid prisma.workspaceComputer.findFirst() invocation: Can't reach database at 127.0.0.1:15432",
    ),
  );
  expect(document.body.textContent).toContain("This page could not be loaded.");
  expect(document.body.textContent).toContain("Try again");
  expect(document.body.textContent).not.toContain("Prisma");
  expect(document.body.textContent).not.toContain("127.0.0.1");
  expect(document.body.textContent).not.toContain("Something went wrong");
  cleanup();
});
