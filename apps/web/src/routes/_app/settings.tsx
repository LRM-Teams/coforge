import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";

import { SettingsContent } from "@/components/settings-content";
import { getLocale, setLocale } from "@/paraglide/runtime";

type Theme = "system" | "light" | "dark";

export const Route = createFileRoute("/_app/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const [theme, setTheme] = useState<Theme>("system");
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

  return (
    <SettingsContent
      locale={locale}
      theme={theme}
      onLocaleChange={setLocale}
      onThemeChange={changeTheme}
    />
  );
}
