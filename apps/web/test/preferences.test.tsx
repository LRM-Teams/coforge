import "./dom-setup";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { useState } from "react";
import { RouterContextProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AppShell } from "@/components/app-shell";
import { SettingsContent } from "@/components/settings-content";
import { AppToastProvider } from "@/components/ui/toast";
import { overwriteGetLocale } from "@/paraglide/runtime";
import { getRouter } from "@/router";

const signedInUser = { name: "Frank An", email: "frank@example.com" };

overwriteGetLocale(() => "en");

beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = "";
  window.innerWidth = 1024;
});

afterEach(cleanup);

function renderShell() {
  return render(
    <RouterContextProvider router={getRouter()}>
      <AppToastProvider>
        <AppShell user={signedInUser}>
          <div />
        </AppShell>
      </AppToastProvider>
    </RouterContextProvider>,
  );
}

function renderSettings() {
  function SettingsTestPage() {
    const [theme, setTheme] = useState<"system" | "light" | "dark">("system");
    function changeTheme(nextTheme: "system" | "light" | "dark") {
      setTheme(nextTheme);
      localStorage.setItem("coforge-theme", nextTheme);
      document.documentElement.classList.toggle("dark", nextTheme === "dark");
    }

    return (
      <SettingsContent
        locale="en"
        theme={theme}
        timeZone={null}
        onLocaleChange={() => {}}
        onThemeChange={changeTheme}
        onTimeZoneChange={() => {}}
      />
    );
  }

  return render(<SettingsTestPage />);
}

test("searches time zones by city and sends the IANA identifier to persistence", async () => {
  const user = userEvent.setup({ document });
  let selected = "";
  const view = render(
    <SettingsContent
      locale="en"
      theme="system"
      timeZone={null}
      onLocaleChange={() => {}}
      onThemeChange={() => {}}
      onTimeZoneChange={(timeZone) => {
        selected = timeZone;
      }}
    />,
  );

  await user.click(view.getByRole("combobox", { name: "Time zone" }));
  expect(view.getByRole("status").classList.contains("empty:py-0")).toBeTrue();
  await user.type(view.getByRole("combobox", { name: "Search time zones" }), "Tokyo");
  expect(view.queryByRole("option", { name: /Asia\/Shanghai/ })).toBeNull();
  await user.click(view.getByRole("option", { name: /Asia\/Tokyo/ }));
  expect(selected).toBe("Asia/Tokyo");
});

test("switches to dark mode and remembers the preference", async () => {
  const user = userEvent.setup({ document });
  const view = renderSettings();

  expect(view.getByRole("heading", { name: "Settings" })).toBeTruthy();
  await user.click(view.getByRole("button", { name: "Dark" }));

  expect(document.documentElement.classList.contains("dark")).toBeTrue();
  expect(localStorage.getItem("coforge-theme")).toBe("dark");
});

test("uses the system color scheme by default", () => {
  const view = renderSettings();

  expect(view.getByRole("button", { name: "System" }).getAttribute("aria-pressed")).toBe("true");
});

test("uses the current user avatar as the personal settings menu trigger without a tooltip", () => {
  const view = renderShell();
  const trigger = view.getByRole("button", { name: "Current user" });

  expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
  expect(trigger.hasAttribute("data-base-ui-tooltip-trigger")).toBeFalse();
  expect(trigger.textContent).toBe("F");
});

test("collapses and restores the sidebar with the Mod-B shortcut", () => {
  const view = renderShell();

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
  const view = renderShell();

  await user.click(view.getByRole("button", { name: "Show sidebar" }));
  expect(view.getAllByRole("button", { name: "Hide sidebar" })).toHaveLength(2);

  await user.click(view.getAllByRole("button", { name: "Hide sidebar" })[0]!);
  expect(view.getAllByRole("button", { name: "Hide sidebar" })).toHaveLength(1);
});
