import { useEffect, useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { SettingsContent } from "@/components/settings-content";
import { getUserPreferences, saveUserTimeZone } from "@/features/settings/settings.functions";
import { getLocale, setLocale } from "@/paraglide/runtime";

type Theme = "system" | "light" | "dark";

export const Route = createFileRoute("/_app/settings")({
  loader: () => getUserPreferences(),
  component: SettingsPage,
});

function SettingsPage() {
  const [theme, setTheme] = useState<Theme>("system");
  const { timeZone: savedTimeZone } = Route.useLoaderData();
  const [timeZone, setTimeZone] = useState(savedTimeZone);
  const saveTimeZone = useServerFn(saveUserTimeZone);
  const router = useRouter();
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
    const result = await saveTimeZone({ data: { timeZone: nextTimeZone || null } });
    setTimeZone(result.timeZone);
    await router.invalidate({ sync: true });
  }

  return (
    <SettingsContent
      locale={locale}
      theme={theme}
      timeZone={timeZone}
      onLocaleChange={setLocale}
      onThemeChange={changeTheme}
      onTimeZoneChange={changeTimeZone}
    />
  );
}
