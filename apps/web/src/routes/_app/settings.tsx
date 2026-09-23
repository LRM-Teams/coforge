import { useEffect, useState } from "react";
import { createFileRoute, getRouteApi, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { useQueryClient } from "@tanstack/react-query";

import { SettingsContent, SettingsPending } from "#src/components/settings-content";
import { useAppToast } from "#src/components/ui/toast";
import { PageLoadError } from "#src/features/errors/page-load-error";
import { saveUserProfile } from "#src/features/profiles/profile.functions";
import {
  browserNotificationPermission,
  showPageNotification,
  syncBrowserPushSubscription,
  shouldShowAddToHomeScreenGuide,
} from "#src/features/notifications/browser-push";
import {
  saveBrowserNotificationPreference,
  sendTestBrowserNotification,
  subscribeBrowserPush,
} from "#src/features/notifications/notifications.functions";
import {
  getUserPreferences,
  saveConversationOpenMode,
  saveDateTimePreferences,
} from "#src/features/settings/settings.functions";
import {
  loadMyWorkspaceInvitations,
  loadWorkspaceMembers,
} from "#src/features/workspaces/members.functions";
import { getLocale, setLocale } from "#src/paraglide/runtime";
import { readRailLabels, writeRailLabels } from "#src/features/settings/rail-labels";
import {
  readLiveAgentActivity,
  writeLiveAgentActivity,
} from "#src/features/settings/live-agent-activity";
import { readTextSize, writeTextSize, type TextSizeValue } from "#src/features/settings/text-size";
import {
  conversationOpenMode,
  type ConversationOpenMode,
} from "#src/features/settings/conversation-open-mode";
import { isAppError } from "#src/lib/app-error";
import type { TimeFormat } from "#src/lib/time-format";
import { m } from "#src/paraglide/messages";

type Theme = "system" | "light" | "dark";

const appRoute = getRouteApi("/_app");

const settingsSections = [
  "account",
  "language-region",
  "members",
  "preferences",
  "notifications",
  "integrations",
] as const;

export const Route = createFileRoute("/_app/settings")({
  // The section lives in the URL so it survives the full reload a locale
  // switch triggers and so a settings link can open a specific section.
  validateSearch: z.object({
    section: z.enum(settingsSections).optional().catch(undefined),
    github: z.enum(["connected", "error", "wrong_account"]).optional().catch(undefined),
  }),
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
  pendingComponent: SettingsPending,
  errorComponent: PageLoadError,
  component: SettingsPage,
});

function SettingsPage() {
  const [theme, setTheme] = useState<Theme>("system");
  const [railLabels, setRailLabels] = useState(true);
  const [liveAgentActivity, setLiveAgentActivity] = useState(true);
  const [textSize, setTextSize] = useState<TextSizeValue>("default");
  const { section, github } = Route.useSearch();
  const navigate = Route.useNavigate();
  const {
    timeZone: savedTimeZone,
    timeFormat: savedTimeFormat,
    conversationOpenMode: savedOpenMode,
    members,
  } = Route.useLoaderData();
  const { user: profile, notifications } = appRoute.useLoaderData();
  const [notificationPermission, setNotificationPermission] = useState<
    NotificationPermission | "unsupported"
  >("unsupported");
  const [showAddToHomeScreenGuide, setShowAddToHomeScreenGuide] = useState(false);
  const saveDateTime = useServerFn(saveDateTimePreferences);
  const saveOpenMode = useServerFn(saveConversationOpenMode);
  const saveNotificationPreference = useServerFn(saveBrowserNotificationPreference);
  const subscribePush = useServerFn(subscribeBrowserPush);
  const sendTestNotification = useServerFn(sendTestBrowserNotification);
  const saveProfile = useServerFn(saveUserProfile);
  const router = useRouter();
  const queryClient = useQueryClient();
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
    setRailLabels(readRailLabels());
    setLiveAgentActivity(readLiveAgentActivity());
    setTextSize(readTextSize());
  }, []);

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

  function changeRailLabels(show: boolean) {
    setRailLabels(show);
    writeRailLabels(show);
  }

  function changeLiveAgentActivity(show: boolean) {
    setLiveAgentActivity(show);
    writeLiveAgentActivity(show);
  }

  function changeTextSize(next: TextSizeValue) {
    setTextSize(next);
    writeTextSize(next);
  }

  function changeTheme(nextTheme: Theme) {
    setTheme(nextTheme);
    localStorage.setItem("coforge-theme", nextTheme);
    applyTheme(nextTheme);
  }

  async function changeDateTime(input: { timeZone: string | null; timeFormat: TimeFormat | null }) {
    await saveDateTime({ data: input });
    await router.invalidate({ sync: true });
  }

  async function changeConversationOpenMode(nextMode: ConversationOpenMode) {
    try {
      await saveOpenMode({ data: { mode: nextMode } });
      await router.invalidate({ sync: true });
    } catch {
      toast.error(m.settings_save_error());
    }
  }

  async function registerCurrentBrowser(requestPermission: boolean) {
    if (!notifications.publicKey) throw new Error("Web Push is not configured");
    let permission = browserNotificationPermission();
    if (requestPermission && permission === "default")
      permission = await Notification.requestPermission();
    setNotificationPermission(permission);
    if (permission !== "granted") return null;
    return syncBrowserPushSubscription(notifications.publicKey, (data) => subscribePush({ data }));
  }

  async function changeBrowserNotifications(enabled: boolean) {
    try {
      if (enabled && !(await registerCurrentBrowser(true))) return;
      await saveNotificationPreference({ data: { enabled } });
      await router.invalidate({ sync: true });
    } catch {
      toast.error(m.preferences_browser_notifications_save_error());
    }
  }

  async function enableBrowserNotifications() {
    try {
      await registerCurrentBrowser(true);
    } catch {
      toast.error(m.preferences_browser_notifications_save_error());
    }
  }

  async function testBrowserNotification() {
    try {
      // The test button is only enabled once permission is granted; "Allow in browser" asks for it.
      const subscription = await registerCurrentBrowser(false);
      if (!subscription) throw new Error("Browser notification permission is not granted");
      await sendTestNotification({ data: { endpoint: subscription.endpoint } });
      return true;
    } catch (cause) {
      // The server could not reach this browser's push service: notifications still
      // arrive while CoForge is open, so the test shows one from the page itself.
      if (isAppError(cause) && cause.code === "PUSH_SERVICE_UNREACHABLE") {
        try {
          await showPageNotification({
            title: m.preferences_browser_notifications_test_title(),
            body: m.preferences_browser_notifications_test_body(),
            tag: `test:${crypto.randomUUID()}`,
            url: "/settings",
          });
          return true;
        } catch (displayCause) {
          console.warn("page notification test failed", displayCause);
        }
      }
      // A client-side failure with the permission granted is the browser's own push service
      // refusing to create the subscription; name that, and put the raw reason in the console.
      const browserFailed = !isAppError(cause) && browserNotificationPermission() === "granted";
      if (!isAppError(cause)) console.warn("browser push test failed", cause);
      toast.error(
        browserFailed
          ? m.preferences_browser_notifications_test_browser_failed()
          : m.preferences_browser_notifications_test_error(),
      );
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
    await queryClient.invalidateQueries({ queryKey: ["conversation"] });
  }

  async function removeAvatar() {
    const response = await fetch("/api/me/avatar", { method: "DELETE" });
    if (!response.ok) throw new Error("Profile image removal failed");
    await router.invalidate({ sync: true });
    await queryClient.invalidateQueries({ queryKey: ["conversation"] });
  }

  return (
    <SettingsContent
      githubCallbackError={github === "error" || github === "wrong_account"}
      githubWrongAccount={github === "wrong_account"}
      section={section}
      onSectionChange={(next) => void navigate({ search: { section: next }, replace: true })}
      profile={profile}
      members={members}
      locale={locale}
      theme={theme}
      timeZone={savedTimeZone}
      timeFormat={savedTimeFormat}
      browserNotificationsEnabled={notifications.enabled}
      browserNotificationPermission={notificationPermission}
      browserNotificationsConfigured={notifications.publicKey !== null}
      showAddToHomeScreenGuide={showAddToHomeScreenGuide}
      onProfileSave={changeProfile}
      onAvatarUpload={uploadAvatar}
      onAvatarRemove={removeAvatar}
      onLocaleChange={setLocale}
      onThemeChange={changeTheme}
      railLabels={railLabels}
      onRailLabelsChange={changeRailLabels}
      liveAgentActivity={liveAgentActivity}
      onLiveAgentActivityChange={changeLiveAgentActivity}
      textSize={textSize}
      onTextSizeChange={changeTextSize}
      onDateTimeSave={changeDateTime}
      conversationOpenMode={conversationOpenMode(savedOpenMode)}
      onConversationOpenModeChange={changeConversationOpenMode}
      onBrowserNotificationsChange={changeBrowserNotifications}
      onEnableBrowserNotifications={enableBrowserNotifications}
      onTestBrowserNotification={testBrowserNotification}
    />
  );
}
