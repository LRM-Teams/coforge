import { useEffect, useState } from "react";
import { createFileRoute, getRouteApi, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { SettingsContent } from "@/components/settings-content";
import { useAppToast } from "@/components/ui/toast";
import { PageLoadError } from "@/features/errors/page-load-error";
import { saveUserProfile } from "@/features/profiles/profile.functions";
import { getUserPreferences, saveUserTimeZone } from "@/features/settings/settings.functions";
import { getLocale, setLocale } from "@/paraglide/runtime";
import { m } from "@/paraglide/messages";

type Theme = "system" | "light" | "dark";

const appRoute = getRouteApi("/_app");

export const Route = createFileRoute("/_app/settings")({
  loader: () => getUserPreferences(),
  errorComponent: PageLoadError,
  component: SettingsPage,
});

function SettingsPage() {
  const [theme, setTheme] = useState<Theme>("system");
  const { timeZone: savedTimeZone } = Route.useLoaderData();
  const { user: profile } = appRoute.useLoaderData();
  const [timeZone, setTimeZone] = useState(savedTimeZone);
  const saveTimeZone = useServerFn(saveUserTimeZone);
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
    document.documentElement.classList.toggle("dark", dark);
  }

  function changeTheme(nextTheme: Theme) {
    setTheme(nextTheme);
    localStorage.setItem("coforge-theme", nextTheme);
    applyTheme(nextTheme);
  }

  async function changeTimeZone(nextTimeZone: string) {
    try {
      const result = await saveTimeZone({ data: { timeZone: nextTimeZone || null } });
      setTimeZone(result.timeZone);
      await router.invalidate({ sync: true });
    } catch (cause) {
      toast.error(m.settings_save_error(), cause);
    }
  }

  async function changeProfile(input: { name: string; description: string }) {
    try {
      await saveProfile({ data: input });
      await router.invalidate({ sync: true });
    } catch (cause) {
      toast.error(m.settings_profile_save_error(), cause);
      throw cause;
    }
  }

  async function uploadAvatar(file: File) {
    try {
      const form = new FormData();
      form.set("file", file);
      const response = await fetch("/api/me/avatar", { method: "POST", body: form });
      if (!response.ok) throw new Error("Profile image upload failed");
      await router.invalidate({ sync: true });
    } catch (cause) {
      toast.error(m.settings_avatar_save_error(), cause);
      throw cause;
    }
  }

  async function removeAvatar() {
    try {
      const response = await fetch("/api/me/avatar", { method: "DELETE" });
      if (!response.ok) throw new Error("Profile image removal failed");
      await router.invalidate({ sync: true });
    } catch (cause) {
      toast.error(m.settings_avatar_save_error(), cause);
      throw cause;
    }
  }

  return (
    <SettingsContent
      profile={profile}
      locale={locale}
      theme={theme}
      timeZone={timeZone}
      onProfileSave={changeProfile}
      onAvatarUpload={uploadAvatar}
      onAvatarRemove={removeAvatar}
      onLocaleChange={setLocale}
      onThemeChange={changeTheme}
      onTimeZoneChange={changeTimeZone}
    />
  );
}
