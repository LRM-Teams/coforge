import { Check, Clock3, Languages, Moon, Sun, SunMoon } from "lucide-react";

import {
  Combobox,
  ComboboxContent,
  ComboboxItem,
  ComboboxTrigger,
  ComboboxValue,
} from "@/components/ui/combobox";
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
  const timeZoneOptions = getTimeZoneOptions(m.preferences_system());
  const selectedTimeZone = timeZoneOptions.find((option) => option.value === (timeZone ?? ""));

  return (
    <main className="flex-1 p-4 sm:p-5 md:p-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{m.settings_title()}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{m.settings_description()}</p>
      </div>

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
          <div className="mt-5">
            <Combobox
              items={timeZoneOptions}
              value={selectedTimeZone}
              isItemEqualToValue={(option, value) => option.value === value.value}
              filter={(option, query) =>
                option.searchText.includes(query.trim().toLocaleLowerCase())
              }
              onValueChange={(option) => option && onTimeZoneChange(option.value)}
            >
              <ComboboxTrigger aria-label={m.preferences_time_zone()}>
                <ComboboxValue placeholder={m.preferences_system()} />
              </ComboboxTrigger>
              <ComboboxContent
                searchLabel={m.preferences_time_zone_search()}
                searchPlaceholder={m.preferences_time_zone_search_placeholder()}
                emptyLabel={m.preferences_time_zone_no_results()}
              >
                {(option: TimeZoneOption) => (
                  <ComboboxItem key={option.value || "system"} value={option}>
                    {option.label}
                  </ComboboxItem>
                )}
              </ComboboxContent>
            </Combobox>
          </div>
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
    </main>
  );
}

interface TimeZoneOption {
  value: string;
  label: string;
  searchText: string;
  offsetMinutes: number;
}

const TIME_ZONES = Array.from(
  new Set([
    "UTC",
    ...(typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : []),
  ]),
);

function getTimeZoneOptions(systemLabel: string): TimeZoneOption[] {
  return [
    {
      value: "",
      label: systemLabel,
      searchText: systemLabel.toLocaleLowerCase(),
      offsetMinutes: 0,
    },
    ...TIME_ZONE_OPTIONS,
  ];
}

const TIME_ZONE_OPTIONS = TIME_ZONES.map((timeZone) => {
  const offset = getUtcOffset(timeZone);
  const city = (timeZone.split("/").at(-1) ?? timeZone).replaceAll("_", " ");
  const label = `(${offset.label}) ${city} — ${timeZone}`;

  return {
    value: timeZone,
    label,
    searchText: `${label} ${timeZone.replaceAll("_", " ")}`.toLocaleLowerCase(),
    offsetMinutes: offset.minutes,
  };
}).sort(
  (left, right) =>
    left.offsetMinutes - right.offsetMinutes || left.label.localeCompare(right.label),
);

function getUtcOffset(timeZone: string) {
  const timeZoneName = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  })
    .formatToParts(new Date())
    .find((part) => part.type === "timeZoneName")?.value;
  const match = timeZoneName?.match(/^GMT(?:([+-])(\d{2}):(\d{2}))?$/);

  if (!match?.[1] || !match[2] || !match[3]) {
    return { label: "UTC+00:00", minutes: 0 };
  }

  const sign = match[1] === "+" ? 1 : -1;
  return {
    label: `UTC${match[1]}${match[2]}:${match[3]}`,
    minutes: sign * (Number(match[2]) * 60 + Number(match[3])),
  };
}

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
