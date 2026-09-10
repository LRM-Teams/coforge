import { useEffect, useState } from "react";
import { createFileRoute, getRouteApi, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { SettingsContent, SettingsPending } from "@/components/settings-content";
import { useAppToast } from "@/components/ui/toast";
import { PageLoadError } from "@/features/errors/page-load-error";
import { saveUserProfile } from "@/features/profiles/profile.functions";
import {
  browserNotificationPermission,
  ensureBrowserPushSubscription,
  shouldShowAddToHomeScreenGuide,
} from "@/features/notifications/browser-push";
import {
  saveBrowserNotificationPreference,
  sendTestBrowserNotification,
  subscribeBrowserPush,
} from "@/features/notifications/notifications.functions";
import { getUserPreferences, saveUserTimeZone } from "@/features/settings/settings.functions";
import {
  loadMyWorkspaceInvitations,
  loadWorkspaceMembers,
} from "@/features/workspaces/members.functions";
import { getLocale, setLocale } from "@/paraglide/runtime";
import { m } from "@/paraglide/messages";

type Theme = "system" | "light" | "dark";

const appRoute = getRouteApi("/_app");

const settingsSections = ["account", "members", "preferences", "notifications"] as const;

export const Route = createFileRoute("/_app/settings")({
  // The section lives in the URL so it survives the full reload a locale
  // switch triggers and so a settings link can open a specific section.
  validateSearch: z.object({ section: z.enum(settingsSections).optional().catch(undefined) }),
  loader: async () => {
    const [preferences, members, incomingInvitations] = await Promise.all([
      getUserPreferences(),
      loadWorkspaceMembers(),
      loadMyWorkspaceInvitations(),
    ]);
    return {
      ...preferences,
      members: {
        actorUserId: members.actorUserId,
        actorRole: members.actorRole,
        members: members.members,
        pendingInvitations: members.pendingInvitations.map((row) => ({
          id: row.id,
          role: row.role,
          inviteeUsername: row.inviteeUsername,
        })),
        incomingInvitations,
      },
    };
  },
  pendingMs: 300,
  pendingMinMs: 0,
  pendingComponent: SettingsPending,
  errorComponent: PageLoadError,
  component: SettingsPage,
});

function SettingsPage() {
  const [theme, setTheme] = useState<Theme>("system");
  const { section } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { timeZone: savedTimeZone, members } = Route.useLoaderData();
  const { user: profile, notifications } = appRoute.useLoaderData();
  const [timeZone, setTimeZone] = useState(savedTimeZone);
  const [browserNotificationsEnabled, setBrowserNotificationsEnabled] = useState(
    notifications.enabled,
  );
  const [notificationPermission, setNotificationPermission] = useState<
    NotificationPermission | "unsupported"
  >("unsupported");
  const [showAddToHomeScreenGuide, setShowAddToHomeScreenGuide] = useState(false);
  const saveTimeZone = useServerFn(saveUserTimeZone);
  const saveNotificationPreference = useServerFn(saveBrowserNotificationPreference);
  const subscribePush = useServerFn(subscribeBrowserPush);
  const sendTestNotification = useServerFn(sendTestBrowserNotification);
  const saveProfile = useServerFn(saveUserProfile);
  const router = useRouter();
  const toast = useAppToast();
  const locale = getLocale();

  useEffect(() => {
    const storedTheme = localStorage.getItem("coforge-theme");
    const initialTheme =
      storedTheme === "system" || storedTheme === "dark" || storedTheme === "light"
        ? storedTheme
        : "system";
    setTheme(initialTheme);
    applyTheme(initialTheme);
  }, []);

  useEffect(() => {
    setBrowserNotificationsEnabled(notifications.enabled);
  }, [notifications.enabled]);

  useEffect(() => {
    const refreshPermission = () => setNotificationPermission(browserNotificationPermission());
    refreshPermission();
    setShowAddToHomeScreenGuide(shouldShowAddToHomeScreenGuide());
    window.addEventListener("focus", refreshPermission);
    return () => window.removeEventListener("focus", refreshPermission);
  }, []);

  useEffect(() => {
    if (theme !== "system") {
      return;
    }
    const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => applyTheme("system");
    colorScheme.addEventListener("change", handleChange);
    return () => colorScheme.removeEventListener("change", handleChange);
  }, [theme]);

  function applyTheme(nextTheme: Theme) {
    const dark =
      nextTheme === "dark" ||
      (nextTheme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark-mode", dark);
  }

  function changeTheme(nextTheme: Theme) {
    setTheme(nextTheme);
    localStorage.setItem("coforge-theme", nextTheme);
    applyTheme(nextTheme);
  }

  async function changeTimeZone(nextTimeZone: string) {
    try {
      const result = await saveTimeZone({
        data: { timeZone: nextTimeZone || null },
      });
      setTimeZone(result.timeZone);
      await router.invalidate({ sync: true });
    } catch (cause) {
      toast.error(m.settings_save_error(), cause);
    }
  }

  async function registerCurrentBrowser(requestPermission: boolean) {
    if (!notifications.publicKey) throw new Error("Web Push is not configured");
    let permission = browserNotificationPermission();
    if (requestPermission && permission === "default")
      permission = await Notification.requestPermission();
    setNotificationPermission(permission);
    if (permission !== "granted") return null;
    const subscription = await ensureBrowserPushSubscription(notifications.publicKey);
    await subscribePush({ data: subscription });
    return subscription;
  }

  async function changeBrowserNotifications(enabled: boolean) {
    try {
      if (enabled && !(await registerCurrentBrowser(true))) return;
      const saved = await saveNotificationPreference({ data: { enabled } });
      setBrowserNotificationsEnabled(saved.enabled);
      await router.invalidate({ sync: true });
    } catch (cause) {
      toast.error(m.preferences_browser_notifications_save_error(), cause);
    }
  }

  async function enableBrowserNotifications() {
    try {
      await registerCurrentBrowser(true);
    } catch (cause) {
      toast.error(m.preferences_browser_notifications_save_error(), cause);
    }
  }

  async function testBrowserNotification() {
    try {
      const subscription = await registerCurrentBrowser(false);
      if (!subscription) throw new Error("Browser notification permission is not granted");
      await sendTestNotification({ data: { endpoint: subscription.endpoint } });
      return true;
    } catch (cause) {
      toast.error(m.preferences_browser_notifications_test_error(), cause);
      return false;
    }
  }

  async function changeProfile(input: { name: string; description: string }) {
    await saveProfile({ data: input });
    await router.invalidate({ sync: true });
  }

  async function uploadAvatar(file: File) {
    const form = new FormData();
    form.set("file", file);
    const response = await fetch("/api/me/avatar", {
      method: "POST",
      body: form,
    });
    if (!response.ok) throw new Error("Profile image upload failed");
    await router.invalidate({ sync: true });
  }

  async function removeAvatar() {
    const response = await fetch("/api/me/avatar", { method: "DELETE" });
    if (!response.ok) throw new Error("Profile image removal failed");
    await router.invalidate({ sync: true });
  }

  return (
    <SettingsContent
      section={section}
      onSectionChange={(next) => void navigate({ search: { section: next }, replace: true })}
      profile={profile}
      members={members}
      locale={locale}
      theme={theme}
      timeZone={timeZone}
      browserNotificationsEnabled={browserNotificationsEnabled}
      browserNotificationPermission={notificationPermission}
      browserNotificationsConfigured={notifications.publicKey !== null}
      showAddToHomeScreenGuide={showAddToHomeScreenGuide}
      onProfileSave={changeProfile}
      onAvatarUpload={uploadAvatar}
      onAvatarRemove={removeAvatar}
      onLocaleChange={setLocale}
      onThemeChange={changeTheme}
      onTimeZoneChange={changeTimeZone}
      onBrowserNotificationsChange={changeBrowserNotifications}
      onEnableBrowserNotifications={enableBrowserNotifications}
      onTestBrowserNotification={testBrowserNotification}
    />
  );
}
