import "./dom-setup";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { useState } from "react";
import { RouterContextProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/layout/page-header";
import { SettingsContent, SettingsPending } from "@/components/settings-content";
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
const notificationProps = {
  browserNotificationsEnabled: false,
  browserNotificationPermission: "default" as const,
  browserNotificationsConfigured: true,
  showAddToHomeScreenGuide: false,
  onBrowserNotificationsChange: async (_enabled: boolean) => {},
  onEnableBrowserNotifications: async () => {},
  onTestBrowserNotification: async () => true,
};
const membersProps = {
  members: {
    actorUserId: "user-1",
    actorRole: "owner",
    members: [
      {
        userId: "user-1",
        role: "owner",
        username: "frankan",
        displayName: "Frank An",
      },
    ],
    pendingInvitations: [],
    incomingInvitations: [],
  },
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
          <PageHeader heading="Messages" />
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
        {...notificationProps}
        {...membersProps}
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

test("uses separate settings list and content panels with a way back that preserves drafts", async () => {
  const user = userEvent.setup({ document });
  const view = renderSettings();
  const main = view.container.querySelector("main");
  const surface = main?.querySelector(":scope > section");

  expect(main?.classList.contains("h-svh")).toBeTrue();
  expect(main?.classList.contains("md:p-2")).toBeTrue();
  expect(surface?.classList.contains("bg-card")).toBeTrue();
  expect(surface?.classList.contains("md:rounded-xl")).toBeTrue();
  expect(surface?.querySelectorAll(":scope > header")).toHaveLength(1);
  const navigation = view.getByRole("navigation", { name: "Settings" });
  expect(navigation.parentElement).toBe(main);
  expect(navigation.querySelector("ul")?.classList.contains("space-y-1")).toBeTrue();
  expect(view.getByRole("list", { name: "Personal" }).textContent).toBe(
    "AccountPreferencesNotifications",
  );
  expect(view.getByRole("list", { name: "Workspace" }).textContent).toBe("Members");
  expect(view.getAllByRole("heading", { name: "Settings" })).toHaveLength(1);
  await user.click(view.getByRole("button", { name: "Account" }));
  expect(navigation.classList.contains("hidden")).toBeTrue();
  expect(surface?.classList.contains("hidden")).toBeFalse();
  await user.click(view.getByRole("button", { name: /Edit/ }));
  const nameInput = view.getByLabelText("Name");
  await user.clear(nameInput);
  await user.type(nameInput, "Unsaved name");
  await user.click(view.getByRole("button", { name: "Settings" }));
  expect(navigation.classList.contains("hidden")).toBeFalse();
  expect(surface?.classList.contains("hidden")).toBeTrue();
  await user.click(view.getByRole("button", { name: "Account" }));
  expect((view.getByLabelText("Name") as HTMLInputElement).value).toBe("Unsaved name");
  expect(view.container.querySelector(".max-w-6xl")).toBeNull();
});

test("keeps the pending settings state in the same page surface", () => {
  const view = render(<SettingsPending />);
  const main = view.container.querySelector("main");
  const surface = main?.querySelector(":scope > section");

  expect(main?.getAttribute("aria-busy")).toBe("true");
  expect(surface?.classList.contains("bg-card")).toBeTrue();
  expect(surface?.querySelectorAll(":scope > header")).toHaveLength(1);
  expect(main?.querySelector(":scope > nav ul")).toBeTruthy();
  expect(view.getByRole("list", { name: "Personal" }).textContent).toBe(
    "AccountPreferencesNotifications",
  );
  expect(view.getByRole("list", { name: "Workspace" }).textContent).toBe("Members");
});

test("searches time zones by city and sends the IANA identifier to persistence", async () => {
  const user = userEvent.setup({ document });
  let selected = "";
  const view = render(
    <SettingsContent
      {...notificationProps}
      {...membersProps}
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
  const input = view.getByRole("combobox", { name: "Time zone" });
  await user.click(input);
  await user.clear(input);
  await user.type(input, "Tokyo");
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

test("shows the global browser notification state and runs a test notification", async () => {
  const user = userEvent.setup({ document });
  let enabled = true;
  let tested = false;
  const view = render(
    <SettingsContent
      {...notificationProps}
      {...membersProps}
      profile={profile}
      locale="en"
      theme="system"
      timeZone={null}
      browserNotificationsEnabled={true}
      browserNotificationPermission="granted"
      onBrowserNotificationsChange={async (next) => {
        enabled = next;
      }}
      onTestBrowserNotification={async () => {
        tested = true;
        return true;
      }}
      onProfileSave={async () => {}}
      onAvatarUpload={async () => {}}
      onAvatarRemove={async () => {}}
      onLocaleChange={() => {}}
      onThemeChange={() => {}}
      onTimeZoneChange={() => {}}
    />,
  );

  await user.click(view.getByRole("button", { name: "Notifications" }));
  const notificationSwitch = view.getByRole("switch", {
    name: "Browser notifications",
  });
  expect(notificationSwitch.getAttribute("aria-checked")).toBe("true");
  await user.click(view.getByRole("button", { name: "Send test notification" }));
  expect(tested).toBeTrue();
  expect(view.getByRole("status").textContent).toBe("Test notification sent.");
  await user.click(notificationSwitch);
  expect(enabled).toBeFalse();
});

test("explains how to install the app before enabling notifications on iPhone and iPad", async () => {
  const user = userEvent.setup({ document });
  const view = render(
    <SettingsContent
      {...notificationProps}
      {...membersProps}
      profile={profile}
      locale="en"
      theme="system"
      timeZone={null}
      showAddToHomeScreenGuide
      onProfileSave={async () => {}}
      onAvatarUpload={async () => {}}
      onAvatarRemove={async () => {}}
      onLocaleChange={() => {}}
      onThemeChange={() => {}}
      onTimeZoneChange={() => {}}
    />,
  );

  await user.click(view.getByRole("button", { name: "Notifications" }));
  expect(view.getByRole("heading", { name: "Add CoForge to your Home Screen" })).toBeTruthy();
  expect(view.getByText("Tap Share in the Safari toolbar.")).toBeTruthy();
  expect(view.getByText("Choose Add to Home Screen.")).toBeTruthy();
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
      {...notificationProps}
      {...membersProps}
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

  expect(view.getByText("@frankan", { selector: "dd" })).toBeTruthy();
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

test("keeps profile drafts and prevents duplicate saves while a failed save is pending", async () => {
  const user = userEvent.setup({ document });
  let rejectSave!: (cause: unknown) => void;
  const pendingSave = new Promise<void>((_resolve, reject) => {
    rejectSave = reject;
  });
  let saves = 0;
  const view = render(
    <SettingsContent
      {...notificationProps}
      {...membersProps}
      profile={profile}
      locale="en"
      theme="system"
      timeZone={null}
      onProfileSave={() => {
        saves += 1;
        return pendingSave;
      }}
      onAvatarUpload={async () => {}}
      onAvatarRemove={async () => {}}
      onLocaleChange={() => {}}
      onThemeChange={() => {}}
      onTimeZoneChange={() => {}}
    />,
  );

  await user.click(view.getByRole("button", { name: "Edit" }));
  const name = view.getByRole("textbox", { name: "Name" });
  await user.clear(name);
  await user.type(name, "Unsaved name");
  const save = view.getByRole("button", { name: "Save" });
  await user.click(save);
  await user.click(save);

  expect(saves).toBe(1);
  expect(save.hasAttribute("disabled")).toBeTrue();
  rejectSave(new Error("offline"));
  await waitFor(() => expect(view.getByRole("alert")).toBeTruthy());
  expect(view.getByRole("textbox", { name: "Name" }).getAttribute("value")).toBe("Unsaved name");
  expect(view.queryByRole("textbox", { name: "Description" })).toBeTruthy();
});

test("does not repeat a successful avatar update when profile details are retried", async () => {
  const user = userEvent.setup({ document });
  let avatarUploads = 0;
  let profileSaves = 0;
  const view = render(
    <SettingsContent
      {...notificationProps}
      {...membersProps}
      profile={profile}
      locale="en"
      theme="system"
      timeZone={null}
      onProfileSave={async () => {
        profileSaves += 1;
        if (profileSaves === 1) throw new Error("profile unavailable");
      }}
      onAvatarUpload={async () => {
        avatarUploads += 1;
      }}
      onAvatarRemove={async () => {}}
      onLocaleChange={() => {}}
      onThemeChange={() => {}}
      onTimeZoneChange={() => {}}
    />,
  );

  await user.click(view.getByRole("button", { name: "Edit" }));
  await user.type(view.getByRole("textbox", { name: "Name" }), " updated");
  await user.upload(
    view.getByLabelText("Replace picture"),
    new File(["image"], "avatar.png", { type: "image/png" }),
  );
  await user.click(view.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(view.getByRole("alert").textContent).toContain("profile image was updated"),
  );
  await user.click(view.getByRole("button", { name: "Save" }));

  expect(avatarUploads).toBe(1);
  expect(profileSaves).toBe(2);
  expect(view.getByRole("status").textContent).toContain("Profile saved.");
});

test("uses the current user avatar as the personal settings menu trigger without a tooltip", () => {
  const view = renderShell();
  const trigger = view.getByRole("button", { name: "Current user" });

  expect(trigger.getAttribute("aria-haspopup")).toBe("true");
  expect(trigger.hasAttribute("data-base-ui-tooltip-trigger")).toBeFalse();
  expect(trigger.querySelector("[data-avatar]")?.textContent).toBe("F");
});

test("collapses and restores the sidebar with the Mod-B shortcut", () => {
  const view = renderShell();

  expect(view.getByRole("complementary")).toBeTruthy();
  fireEvent.keyDown(document, { key: "b", code: "KeyB", ctrlKey: true });
  fireEvent.keyUp(document, { key: "b", code: "KeyB", ctrlKey: true });
  expect(view.queryByRole("complementary")).toBeNull();
  expect(view.getByRole("link", { name: "Messages" }).getAttribute("href")).toBe("/en/messages");
  expect(view.getByRole("button", { name: "Current user" })).toBeTruthy();

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
