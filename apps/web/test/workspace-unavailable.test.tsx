import "./dom-setup";

import { expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { AppPageError } from "@/features/workspaces/workspace-unavailable";
import { WORKSPACE_UNAVAILABLE } from "@/server/workspaces/workspace-unavailable";

test("a missing Workspace membership is an empty state, not a generic crash", () => {
  render(<AppPageError error={new Error(WORKSPACE_UNAVAILABLE)} />);
  expect(document.body.textContent).toContain("No Workspace yet");
  expect(document.body.textContent).toContain("Sign out");
  expect(document.body.textContent).not.toContain("Something went wrong");
  cleanup();
});

test("other page errors stay readable inside the app", () => {
  render(<AppPageError error={new Error("Agent persistence is unavailable")} />);
  expect(document.body.textContent).toContain("This page could not be loaded.");
  expect(document.body.textContent).toContain("Agent persistence is unavailable");
  expect(document.body.textContent).not.toContain("Something went wrong");
  cleanup();
});
