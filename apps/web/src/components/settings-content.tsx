import { Check, Clock3, Languages, Moon, Sun, SunMoon } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { m } from "@/paraglide/messages";

type Locale = "en" | "zh-CN";
type Theme = "system" | "light" | "dark";

interface SettingsContentProps {
  locale: Locale;
  theme: Theme;
  timeZone: string | null;
  onLocaleChange: (locale: Locale) => void;
  onThemeChange: (theme: Theme) => void;
  onTimeZoneChange: (timeZone: string) => void;
}

export function SettingsContent({
  locale,
  theme,
  timeZone,
  onLocaleChange,
  onThemeChange,
  onTimeZoneChange,
}: SettingsContentProps) {
  return (
    <main className="flex-1 p-2">
      <div className="min-h-[calc(100svh_-_1rem)] overflow-hidden rounded-xl border bg-card">
        <PageHeader heading={m.settings_title()} />
        <div className="p-4 sm:p-5 md:p-6">
          <p className="text-sm text-muted-foreground">{m.settings_description()}</p>
          <div className="mt-8 max-w-2xl space-y-4">
            <section className="rounded-lg border bg-card p-4 sm:p-5">
              <div className="flex items-start gap-3">
                <Languages aria-hidden="true" className="mt-0.5 size-4 text-muted-foreground" />
                <div>
                  <h2 className="text-sm font-semibold">{m.preferences_language()}</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {m.settings_language_description()}
                  </p>
                </div>
              </div>
              <div className="mt-5 grid gap-2 sm:grid-cols-2">
                <PreferenceButton
                  selected={locale === "en"}
                  label={m.preferences_english()}
                  onClick={() => onLocaleChange("en")}
                />
                <PreferenceButton
                  selected={locale === "zh-CN"}
                  label={m.preferences_chinese()}
                  onClick={() => onLocaleChange("zh-CN")}
                />
              </div>
            </section>

            <section className="rounded-lg border bg-card p-4 sm:p-5">
              <div className="flex items-start gap-3">
                <Clock3 aria-hidden="true" className="mt-0.5 size-4 text-muted-foreground" />
                <div>
                  <h2 className="text-sm font-semibold">{m.preferences_time_zone()}</h2>
                </div>
              </div>
              <label className="mt-5 grid gap-1.5 text-sm">
                <span className="sr-only">{m.preferences_time_zone()}</span>
                <select
                  aria-label={m.preferences_time_zone()}
                  value={timeZone ?? ""}
                  onChange={(event) => onTimeZoneChange(event.target.value)}
                  className="h-10 rounded-md border bg-background px-3"
                >
                  <option value="">{m.preferences_system()}</option>
                  {TIME_ZONES.map((zone) => (
                    <option key={zone} value={zone}>
                      {zone}
                    </option>
                  ))}
                </select>
              </label>
            </section>

            <section className="rounded-lg border bg-card p-4 sm:p-5">
              <div className="flex items-start gap-3">
                {theme === "system" ? (
                  <SunMoon aria-hidden="true" className="mt-0.5 size-4 text-muted-foreground" />
                ) : theme === "light" ? (
                  <Sun aria-hidden="true" className="mt-0.5 size-4 text-muted-foreground" />
                ) : (
                  <Moon aria-hidden="true" className="mt-0.5 size-4 text-muted-foreground" />
                )}
                <div>
                  <h2 className="text-sm font-semibold">{m.preferences_appearance()}</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {m.settings_appearance_description()}
                  </p>
                </div>
              </div>
              <div className="mt-5 grid gap-2 sm:grid-cols-3">
                <PreferenceButton
                  selected={theme === "system"}
                  label={m.preferences_system()}
                  onClick={() => onThemeChange("system")}
                />
                <PreferenceButton
                  selected={theme === "light"}
                  label={m.preferences_light()}
                  onClick={() => onThemeChange("light")}
                />
                <PreferenceButton
                  selected={theme === "dark"}
                  label={m.preferences_dark()}
                  onClick={() => onThemeChange("dark")}
                />
              </div>
            </section>
          </div>
        </div>
      </div>
    </main>
  );
}

const TIME_ZONES = Array.from(
  new Set([
    "UTC",
    ...(typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : []),
  ]),
);

function PreferenceButton({
  selected,
  label,
  onClick,
}: {
  selected: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={
        selected
          ? "flex h-10 items-center rounded-md border border-brand bg-accent px-3 text-left text-sm text-accent-foreground"
          : "flex h-10 items-center rounded-md border bg-background px-3 text-left text-sm hover:bg-muted"
      }
    >
      {label}
      {selected && <Check aria-hidden="true" className="ml-auto size-4" />}
    </button>
  );
}
