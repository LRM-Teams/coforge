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
const profile = {
  name: "Frank An",
  email: "frank@example.com",
  username: "frankan",
  description: "Building CoForge.",
  avatarUrl: null,
};

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
        profile={profile}
        locale="en"
        theme={theme}
        timeZone={null}
        onProfileSave={async () => {}}
        onAvatarUpload={async () => {}}
        onAvatarRemove={async () => {}}
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
      profile={profile}
      locale="en"
      theme="system"
      timeZone={null}
      onProfileSave={async () => {}}
      onAvatarUpload={async () => {}}
      onAvatarRemove={async () => {}}
      onLocaleChange={() => {}}
      onThemeChange={() => {}}
      onTimeZoneChange={(timeZone) => {
        selected = timeZone;
      }}
    />,
  );

  await user.click(view.getByRole("button", { name: "Preferences" }));
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
  await user.click(view.getByRole("button", { name: "Preferences" }));
  await user.click(view.getByRole("button", { name: "Dark" }));

  expect(document.documentElement.classList.contains("dark")).toBeTrue();
  expect(localStorage.getItem("coforge-theme")).toBe("dark");
});

test("uses the system color scheme by default", () => {
  const view = renderSettings();

  expect(view.getByRole("button", { name: "Account" }).getAttribute("aria-current")).toBe("page");
});

test("edits the profile name and description and uploads a profile image on save", async () => {
  const user = userEvent.setup({ document });
  let savedName = "";
  let savedDescription = "";
  let uploadedFile: File | undefined;
  const view = render(
    <SettingsContent
      profile={profile}
      locale="en"
      theme="system"
      timeZone={null}
      onProfileSave={async (nextProfile) => {
        savedName = nextProfile.name;
        savedDescription = nextProfile.description;
      }}
      onAvatarUpload={async (file) => {
        uploadedFile = file;
      }}
      onAvatarRemove={async () => {}}
      onLocaleChange={() => {}}
      onThemeChange={() => {}}
      onTimeZoneChange={() => {}}
    />,
  );

  expect(view.getByText("@frankan")).toBeTruthy();
  expect(view.queryByRole("textbox", { name: "Description" })).toBeNull();
  await user.click(view.getByRole("button", { name: "Edit" }));
  const name = view.getByRole("textbox", { name: "Name" });
  await user.clear(name);
  await user.type(name, "Frank An Updated");
  const description = view.getByRole("textbox", { name: "Description" });
  await user.clear(description);
  await user.type(description, "Helping teams ship reliable software.");

  const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "avatar.png", {
    type: "image/png",
  });
  await user.upload(view.getByLabelText("Replace picture"), file);
  expect(uploadedFile).toBeUndefined();
  await user.click(view.getByRole("button", { name: "Save" }));
  expect(savedName).toBe("Frank An Updated");
  expect(savedDescription).toBe("Helping teams ship reliable software.");
  expect(uploadedFile).toBe(file);
  expect(view.queryByRole("textbox", { name: "Description" })).toBeNull();
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
