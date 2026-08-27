import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AppShell } from "@/components/app-shell";
import { overwriteGetLocale } from "@/paraglide/runtime";

GlobalRegistrator.register({ url: "http://localhost/en" });
overwriteGetLocale(() => "en");

beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = "";
  window.innerWidth = 1024;
});

afterEach(cleanup);

test("switches to dark mode and remembers the preference", async () => {
  const user = userEvent.setup({ document });
  const view = render(<AppShell page="settings" />);

  expect(view.getByRole("heading", { name: "Settings" })).toBeTruthy();
  await user.click(view.getByRole("button", { name: "Dark" }));

  expect(document.documentElement.classList.contains("dark")).toBeTrue();
  expect(localStorage.getItem("coforge-theme")).toBe("dark");
});

test("uses the system color scheme by default", () => {
  const view = render(<AppShell page="settings" />);

  expect(view.getByRole("button", { name: "System" }).getAttribute("aria-pressed")).toBe("true");
});

test("uses the current user avatar as the personal settings menu trigger without a tooltip", () => {
  const view = render(<AppShell />);
  const trigger = view.getByRole("button", { name: "Current user" });

  expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
  expect(trigger.hasAttribute("data-base-ui-tooltip-trigger")).toBeFalse();
});

test("collapses and restores the sidebar with the Mod-B shortcut", () => {
  const view = render(<AppShell />);

  expect(view.getByRole("complementary")).toBeTruthy();
  fireEvent.keyDown(document, { key: "b", code: "KeyB", ctrlKey: true });
  fireEvent.keyUp(document, { key: "b", code: "KeyB", ctrlKey: true });
  expect(view.queryByRole("complementary")).toBeNull();
  expect(view.getByRole("button", { name: "Show sidebar" })).toBeTruthy();

  fireEvent.keyDown(document, { key: "b", code: "KeyB", ctrlKey: true });
  fireEvent.keyUp(document, { key: "b", code: "KeyB", ctrlKey: true });
  expect(view.getByRole("complementary")).toBeTruthy();
});

test("opens and dismisses the sidebar as a mobile drawer", async () => {
  window.innerWidth = 390;
  const user = userEvent.setup({ document });
  const view = render(<AppShell />);

  await user.click(view.getByRole("button", { name: "Show sidebar" }));
  expect(view.getAllByRole("button", { name: "Hide sidebar" })).toHaveLength(2);

  await user.click(view.getAllByRole("button", { name: "Hide sidebar" })[0]!);
  expect(view.getAllByRole("button", { name: "Hide sidebar" })).toHaveLength(1);
});
