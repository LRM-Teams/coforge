import { useEffect, useState, type ChangeEvent } from "react";
import {
  Check,
  Clock3,
  Languages,
  Moon,
  SlidersHorizontal,
  Sun,
  SunMoon,
  Upload,
  UserRound,
} from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { Avatar } from "@/components/ui/avatar";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxItem,
  ComboboxTrigger,
  ComboboxValue,
} from "@/components/ui/combobox";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";

type Locale = "en" | "zh-CN";
type Theme = "system" | "light" | "dark";
type SettingsSection = "account" | "preferences";

interface SettingsContentProps {
  profile: {
    name: string;
    email: string;
    username: string;
    description: string;
    avatarUrl: string | null;
  };
  locale: Locale;
  theme: Theme;
  timeZone: string | null;
  onProfileSave: (profile: { name: string; description: string }) => Promise<void>;
  onAvatarUpload: (file: File) => Promise<void>;
  onAvatarRemove: () => Promise<void>;
  onLocaleChange: (locale: Locale) => void;
  onThemeChange: (theme: Theme) => void;
  onTimeZoneChange: (timeZone: string) => void;
}

export function SettingsContent(props: SettingsContentProps) {
  const [section, setSection] = useState<SettingsSection>("account");

  return (
    <main className="flex h-svh min-w-0 flex-col gap-2 p-2 md:flex-row">
      <nav className="shrink-0 overflow-hidden rounded-xl border bg-card md:flex md:w-64 md:flex-col">
        <div className="hidden md:block">
          <PageHeader heading={m.settings_title()} />
        </div>
        <div className="grid grid-cols-2 gap-1 p-2 md:block md:space-y-1">
          <SettingsNavigationButton
            active={section === "account"}
            icon={<UserRound aria-hidden="true" />}
            label={m.settings_account()}
            onClick={() => setSection("account")}
          />
          <SettingsNavigationButton
            active={section === "preferences"}
            icon={<SlidersHorizontal aria-hidden="true" />}
            label={m.settings_preferences()}
            onClick={() => setSection("preferences")}
          />
        </div>
      </nav>

      <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card">
        <PageHeader
          heading={section === "account" ? m.settings_account() : m.settings_preferences()}
        />
        <div className="min-h-0 flex-1 overflow-y-auto">
          {section === "account" ? <AccountSettings {...props} /> : <Preferences {...props} />}
        </div>
      </section>
    </main>
  );
}

function SettingsNavigationButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={cn(
        "flex h-10 w-full items-center gap-2.5 rounded-lg px-3 text-left text-sm hover:bg-muted",
        active && "bg-muted font-medium text-accent-foreground",
      )}
    >
      <span className="[&_svg]:size-4">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}

function AccountSettings({
  profile,
  onProfileSave,
  onAvatarUpload,
  onAvatarRemove,
}: SettingsContentProps) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(profile.name);
  const [description, setDescription] = useState(profile.description);
  const [saving, setSaving] = useState(false);
  const [pendingAvatar, setPendingAvatar] = useState<File | null>(null);
  const [removeAvatar, setRemoveAvatar] = useState(false);

  useEffect(() => {
    setName(profile.name);
    setDescription(profile.description);
  }, [profile.name, profile.description]);

  function startEditing() {
    setName(profile.name);
    setDescription(profile.description);
    setPendingAvatar(null);
    setRemoveAvatar(false);
    setEditing(true);
  }

  function cancelEditing() {
    setName(profile.name);
    setDescription(profile.description);
    setPendingAvatar(null);
    setRemoveAvatar(false);
    setEditing(false);
  }

  async function save() {
    setSaving(true);
    try {
      if (pendingAvatar) await onAvatarUpload(pendingAvatar);
      else if (removeAvatar) await onAvatarRemove();
      if (name !== profile.name || description !== profile.description)
        await onProfileSave({ name, description });
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setPendingAvatar(file);
    setRemoveAvatar(false);
  }

  const avatarChanged = pendingAvatar !== null || removeAvatar;
  const changed = avatarChanged || name !== profile.name || description !== profile.description;

  return (
    <div className="mx-auto w-full max-w-4xl p-4 sm:p-6 lg:p-8">
      <section className="overflow-hidden rounded-xl border bg-background">
        <header className="flex min-h-16 items-center justify-between gap-4 px-5 py-3 sm:px-6">
          <h2 className="text-lg font-semibold">{m.settings_profile()}</h2>
          {!editing && (
            <Button type="button" variant="outline" onClick={startEditing}>
              {m.settings_profile_edit()}
            </Button>
          )}
        </header>

        {editing ? (
          <>
            <div className="border-t p-5 sm:p-6">
              <div className="flex flex-wrap items-center gap-4">
                <Avatar
                  people={[{ name: profile.name, src: removeAvatar ? null : profile.avatarUrl }]}
                  size="xl"
                  className="size-20 rounded-full text-xl"
                />
                <div className="flex flex-wrap items-center gap-2">
                  <label className={buttonVariants({ variant: "outline" })}>
                    <Upload aria-hidden="true" />
                    {m.settings_avatar_change()}
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      aria-label={m.settings_avatar_change()}
                      disabled={saving}
                      className="sr-only"
                      onChange={upload}
                    />
                  </label>
                  {profile.avatarUrl && !removeAvatar && (
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={saving}
                      onClick={() => {
                        setPendingAvatar(null);
                        setRemoveAvatar(true);
                      }}
                    >
                      {m.settings_avatar_remove()}
                    </Button>
                  )}
                </div>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{m.settings_avatar_help()}</p>

              <div className="mt-7">
                <label htmlFor="profile-name" className="text-sm font-medium">
                  {m.settings_name()}
                </label>
                <input
                  id="profile-name"
                  value={name}
                  maxLength={80}
                  disabled={saving}
                  onChange={(event) => setName(event.target.value)}
                  className="mt-2 h-10 w-full rounded-lg border bg-card px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                />
              </div>

              <div className="mt-5">
                <label htmlFor="profile-description" className="text-sm font-medium">
                  {m.settings_user_description()}
                </label>
                <textarea
                  id="profile-description"
                  value={description}
                  maxLength={280}
                  rows={4}
                  placeholder={m.settings_user_description_placeholder()}
                  disabled={saving}
                  onChange={(event) => setDescription(event.target.value)}
                  className="mt-2 w-full resize-none rounded-lg border bg-card px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                />
                <p className="mt-2 text-right font-mono text-xs tracking-tight text-muted-foreground tabular-nums">
                  {description.length}/280
                </p>
              </div>
            </div>

            <footer className="flex justify-end gap-2 border-t px-5 py-4 sm:px-6">
              <Button type="button" variant="outline" disabled={saving} onClick={cancelEditing}>
                {m.settings_profile_cancel()}
              </Button>
              <Button type="button" disabled={saving || !changed} onClick={save}>
                {m.settings_profile_save()}
              </Button>
            </footer>
          </>
        ) : (
          <>
            <div className="grid items-center gap-5 border-t p-5 sm:p-6 md:grid-cols-[auto_repeat(3,minmax(0,1fr))] md:gap-8">
              <Avatar
                people={[{ name: profile.name, src: profile.avatarUrl }]}
                size="xl"
                className="size-20 rounded-full text-xl"
              />
              <ProfileValue label={m.settings_name()} value={profile.name} />
              <ProfileValue label={m.settings_email()} value={profile.email} />
              <ProfileValue label={m.settings_username()} value={`@${profile.username}`} />
            </div>
            <div className="border-t px-5 py-4 sm:px-6">
              <p className="text-xs text-muted-foreground">{m.settings_user_description()}</p>
              <p className={cn("mt-1 text-sm", !profile.description && "text-muted-foreground")}>
                {profile.description || "-"}
              </p>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function ProfileValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 truncate text-sm font-medium">{value}</dd>
    </div>
  );
}

function Preferences({
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
    <div className="mx-auto w-full max-w-3xl p-4 sm:p-6 lg:p-8">
      <div className="space-y-4">
        <PreferenceSection
          icon={<Languages aria-hidden="true" />}
          heading={m.preferences_language()}
        >
          <div className="grid gap-2 sm:grid-cols-2">
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
        </PreferenceSection>

        <PreferenceSection icon={<Clock3 aria-hidden="true" />} heading={m.preferences_time_zone()}>
          <Combobox
            items={timeZoneOptions}
            value={selectedTimeZone}
            isItemEqualToValue={(option, value) => option.value === value.value}
            filter={(option, query) => option.searchText.includes(query.trim().toLocaleLowerCase())}
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
        </PreferenceSection>

        <PreferenceSection
          icon={
            theme === "system" ? (
              <SunMoon aria-hidden="true" />
            ) : theme === "light" ? (
              <Sun aria-hidden="true" />
            ) : (
              <Moon aria-hidden="true" />
            )
          }
          heading={m.preferences_appearance()}
        >
          <div className="grid gap-2 sm:grid-cols-3">
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
        </PreferenceSection>
      </div>
    </div>
  );
}

function PreferenceSection({
  icon,
  heading,
  children,
}: {
  icon: React.ReactNode;
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border bg-background p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-muted-foreground [&_svg]:size-4">{icon}</span>
        <h3 className="text-sm font-semibold">{heading}</h3>
      </div>
      <div className="mt-5">{children}</div>
    </section>
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
  const label = `(${offset.label}) ${city} - ${timeZone}`;

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
      className={cn(
        "flex h-10 w-full items-center rounded-lg border bg-card px-3 text-left text-sm hover:bg-muted",
        selected && "border-brand bg-accent text-accent-foreground",
      )}
    >
      {label}
      {selected && <Check aria-hidden="true" className="ml-auto size-4" />}
    </button>
  );
}
