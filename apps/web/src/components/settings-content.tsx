import { useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  BellRinging01 as BellRing,
  Check,
  ChevronLeft,
  Clock as Clock3,
  Translate01 as Languages,
  Moon01 as Moon,
  Sliders01 as SlidersHorizontal,
  Sun,
  SunSetting01 as SunMoon,
  Upload01 as Upload,
  UserCircle as UserRound,
  Users01 as Users,
} from "@untitledui/icons";

import { PageHeader } from "@/components/layout/page-header";
import { Avatar } from "@/components/base/avatar/avatar";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Skeleton } from "@/components/ui/skeleton";
import { ComboBox } from "@/components/base/select/combobox";
import { SelectItem } from "@/components/base/select/select-item";
import { Toggle } from "@/components/base/toggle/toggle";
import { WorkspaceMembersPanel } from "@/features/workspaces/workspace-members-panel";
import { avatarInitial, avatarToneClassName } from "@/lib/avatar-tone";
import { cn } from "@/lib/utils";
import { isAppError } from "@/lib/app-error";
import { m } from "@/paraglide/messages";

type Locale = "en" | "zh-CN";
type Theme = "system" | "light" | "dark";
type SettingsSection = "account" | "members" | "preferences" | "notifications";

interface SettingsContentProps {
  profile: {
    name: string;
    email: string;
    username: string;
    description: string;
    avatarUrl: string | null;
  };
  members: {
    actorUserId: string;
    actorRole: string;
    members: Array<{
      userId: string;
      role: string;
      username: string;
      displayName: string | null;
    }>;
    pendingInvitations: Array<{
      id: string;
      role: string;
      inviteeUsername: string;
    }>;
    incomingInvitations: Array<{
      id: string;
      role: string;
      workspace: { name: string; slug: string };
      inviterUsername: string;
    }>;
  };
  locale: Locale;
  theme: Theme;
  timeZone: string | null;
  browserNotificationsEnabled: boolean;
  browserNotificationPermission: NotificationPermission | "unsupported";
  browserNotificationsConfigured: boolean;
  showAddToHomeScreenGuide: boolean;
  onProfileSave: (profile: { name: string; description: string }) => Promise<void>;
  onAvatarUpload: (file: File) => Promise<void>;
  onAvatarRemove: () => Promise<void>;
  onLocaleChange: (locale: Locale) => void;
  onThemeChange: (theme: Theme) => void;
  onTimeZoneChange: (timeZone: string) => void;
  onBrowserNotificationsChange: (enabled: boolean) => Promise<void>;
  onEnableBrowserNotifications: () => Promise<void>;
  onTestBrowserNotification: () => Promise<boolean>;
}

export function SettingsPending() {
  return (
    <main aria-busy="true" className="flex h-svh min-w-0 md:gap-2 md:p-2">
      <p role="status" className="sr-only">
        {m.settings_loading()}
      </p>
      <nav className="flex w-full min-w-0 flex-col overflow-hidden border-r border-secondary bg-primary md:w-60 md:shrink-0">
        <PageHeader heading={m.settings_title()} />
        <div className="space-y-5 overflow-y-auto p-3">
          {[
            {
              label: m.settings_personal_group(),
              items: [m.settings_account(), m.settings_preferences(), m.settings_notifications()],
            },
            { label: m.settings_workspace_group(), items: [m.settings_members()] },
          ].map((group) => (
            <SettingsNavigationGroup key={group.label} label={group.label}>
              {group.items.map((label) => (
                <li key={label} className="flex h-11 items-center gap-3 px-3 text-sm font-medium">
                  <span>{label}</span>
                </li>
              ))}
            </SettingsNavigationGroup>
          ))}
        </div>
      </nav>
      <section className="@container/settings hidden min-w-0 flex-1 flex-col overflow-hidden bg-primary md:flex">
        <PageHeader heading={m.settings_account()} />
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 pb-8 sm:px-6">
          <section>
            <header className="flex min-h-16 items-center pb-5">
              <h2 className="text-lg font-semibold">{m.settings_profile()}</h2>
            </header>
            <div
              aria-hidden="true"
              className="space-y-6 border-t border-secondary py-6 motion-safe:animate-pulse"
            >
              <Skeleton className="size-20 rounded-full" />
              {["w-3/5", "w-4/5", "w-2/3"].map((width) => (
                <div
                  key={width}
                  className="grid gap-2 border-t border-secondary pt-5 @2xl/settings:grid-cols-[240px_minmax(0,1fr)] @2xl/settings:gap-8"
                >
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className={`h-4 ${width}`} />
                </div>
              ))}
            </div>
            <div
              aria-hidden="true"
              className="grid gap-2 border-t border-secondary py-5 motion-safe:animate-pulse @2xl/settings:grid-cols-[240px_minmax(0,1fr)] @2xl/settings:gap-8"
            >
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-4 w-3/5" />
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}

export function SettingsContent(props: SettingsContentProps) {
  const [section, setSection] = useState<SettingsSection>("account");
  const [showList, setShowList] = useState(true);
  const sectionLabel =
    section === "account"
      ? m.settings_account()
      : section === "members"
        ? m.settings_members()
        : section === "preferences"
          ? m.settings_preferences()
          : m.settings_notifications();

  function selectSection(next: SettingsSection) {
    setSection(next);
    setShowList(false);
  }

  return (
    <main className="flex h-svh min-w-0 md:gap-2 md:p-2">
      <nav
        aria-label={m.settings_title()}
        className={cn(
          "min-w-0 flex-col overflow-hidden border-secondary bg-primary md:flex md:w-60 md:shrink-0 md:border-r",
          showList ? "flex w-full" : "hidden",
        )}
      >
        <PageHeader heading={m.settings_title()} />
        <div className="space-y-5 overflow-y-auto p-3">
          <SettingsNavigationGroup label={m.settings_personal_group()}>
            <SettingsNavigationButton
              active={section === "account"}
              icon={<UserRound aria-hidden="true" />}
              label={m.settings_account()}
              onClick={() => selectSection("account")}
            />
            <SettingsNavigationButton
              active={section === "preferences"}
              icon={<SlidersHorizontal aria-hidden="true" />}
              label={m.settings_preferences()}
              onClick={() => selectSection("preferences")}
            />
            <SettingsNavigationButton
              active={section === "notifications"}
              icon={<BellRing aria-hidden="true" />}
              label={m.settings_notifications()}
              onClick={() => selectSection("notifications")}
            />
          </SettingsNavigationGroup>
          <SettingsNavigationGroup label={m.settings_workspace_group()}>
            <SettingsNavigationButton
              active={section === "members"}
              icon={<Users aria-hidden="true" />}
              label={m.settings_members()}
              onClick={() => selectSection("members")}
            />
          </SettingsNavigationGroup>
        </div>
      </nav>
      <section
        className={cn(
          "@container/settings min-w-0 flex-1 flex-col overflow-hidden bg-primary md:flex",
          showList ? "hidden" : "flex",
        )}
      >
        <PageHeader
          heading={sectionLabel}
          leading={
            <ButtonUtility
              icon={ChevronLeft}
              color="tertiary"
              size="sm"
              className="-ml-2 size-11 md:hidden"
              tooltip={m.settings_title()}
              onClick={() => setShowList(true)}
            />
          }
        />

        <section
          aria-label={
            section === "account"
              ? m.settings_account()
              : section === "members"
                ? m.settings_members()
                : section === "preferences"
                  ? m.settings_preferences()
                  : m.settings_notifications()
          }
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          <div className="min-h-0 flex-1 overflow-y-auto">
            {section === "account" ? (
              <AccountSettings {...props} />
            ) : section === "members" ? (
              <WorkspaceMembersPanel
                actorUserId={props.members.actorUserId}
                actorRole={props.members.actorRole}
                members={props.members.members}
                pendingInvitations={props.members.pendingInvitations}
                incomingInvitations={props.members.incomingInvitations}
              />
            ) : section === "preferences" ? (
              <Preferences {...props} />
            ) : (
              <NotificationSettings {...props} />
            )}
          </div>
        </section>
      </section>
    </main>
  );
}

function SettingsNavigationGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h2 className="px-3 pt-2 pb-2 text-xs font-semibold text-tertiary">{label}</h2>
      <ul aria-label={label} className="space-y-1">
        {children}
      </ul>
    </div>
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
    <li>
      <Button
        type="button"
        color="tertiary"
        aria-current={active ? "page" : undefined}
        onPress={onClick}
        className={cn(
          "h-11 w-full min-w-0 justify-start gap-3 rounded-lg px-3 text-sm font-medium",
          active && "bg-brand-primary text-brand-secondary",
        )}
      >
        <span className="inline-flex shrink-0 [&_svg]:size-4">{icon}</span>
        <span className="truncate">{label}</span>
      </Button>
    </li>
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
  const savingRef = useRef(false);
  const [pendingAvatar, setPendingAvatar] = useState<File | null>(null);
  const [removeAvatar, setRemoveAvatar] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) {
      setName(profile.name);
      setDescription(profile.description);
    }
  }, [editing, profile.name, profile.description]);

  function startEditing() {
    setName(profile.name);
    setDescription(profile.description);
    setPendingAvatar(null);
    setRemoveAvatar(false);
    setSaveError(null);
    setSaveSuccess(false);
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
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    let avatarSaved = false;
    try {
      if (pendingAvatar) {
        await onAvatarUpload(pendingAvatar);
        avatarSaved = true;
        setPendingAvatar(null);
      } else if (removeAvatar) {
        await onAvatarRemove();
        avatarSaved = true;
        setRemoveAvatar(false);
      }
      if (name !== profile.name || description !== profile.description)
        await onProfileSave({ name, description });
      setSaveSuccess(true);
      setEditing(false);
    } catch (cause) {
      const message = avatarSaved
        ? m.settings_profile_save_partial_error()
        : avatarChanged
          ? m.settings_avatar_save_error()
          : m.settings_profile_save_error();
      const reference =
        isAppError(cause) && cause.errorId
          ? ` ${m.error_reference({ errorId: cause.errorId })}`
          : "";
      setSaveError(`${message}${reference}`);
    } finally {
      savingRef.current = false;
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
    <div className="w-full px-4 pb-8 sm:px-6">
      <section>
        <header className="flex min-h-16 items-center justify-between gap-4 py-5">
          <h2 className="text-lg font-semibold">{m.settings_profile()}</h2>
          {!editing && (
            <Button type="button" color="secondary" onPress={startEditing}>
              {m.settings_profile_edit()}
            </Button>
          )}
        </header>

        {editing ? (
          <>
            <div className="border-t border-secondary py-6">
              <div className="flex flex-wrap items-center gap-4">
                <Avatar
                  size="2xl"
                  src={removeAvatar ? null : profile.avatarUrl}
                  alt={profile.name}
                  initials={avatarInitial(profile.name)}
                  contentClassName={avatarToneClassName(profile.name)}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    color="secondary"
                    iconLeading={Upload}
                    isDisabled={saving}
                    onPress={() => avatarInputRef.current?.click()}
                  >
                    {m.settings_avatar_change()}
                  </Button>
                  <input
                    ref={avatarInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    aria-label={m.settings_avatar_change()}
                    disabled={saving}
                    className="sr-only"
                    onChange={upload}
                  />
                  {profile.avatarUrl && !removeAvatar && (
                    <Button
                      type="button"
                      color="tertiary"
                      isDisabled={saving}
                      onPress={() => {
                        setPendingAvatar(null);
                        setRemoveAvatar(true);
                      }}
                    >
                      {m.settings_avatar_remove()}
                    </Button>
                  )}
                </div>
              </div>
              <p className="mt-2 text-xs text-tertiary">{m.settings_avatar_help()}</p>

              <div className="mt-6 grid gap-6 border-t border-secondary pt-6 md:grid-cols-2 xl:grid-cols-3">
                <div className="flex flex-col gap-1">
                  <label htmlFor="profile-name" className="text-sm text-tertiary">
                    {m.settings_name()}
                  </label>
                  <input
                    id="profile-name"
                    value={name}
                    maxLength={80}
                    disabled={saving}
                    onChange={(event) => setName(event.target.value)}
                    className="h-10 w-full rounded-lg bg-primary px-3 text-sm shadow-xs ring-1 ring-primary ring-inset outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50"
                  />
                </div>

                <div className="flex flex-col gap-1 md:col-span-2 xl:col-span-3">
                  <label htmlFor="profile-description" className="text-sm text-tertiary">
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
                    className="w-full resize-none rounded-lg bg-primary px-3 py-2 text-sm shadow-xs ring-1 ring-primary ring-inset outline-none placeholder:text-quaternary focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50"
                  />
                  <p className="text-right text-sm text-tertiary tabular-nums">
                    {description.length}/280
                  </p>
                </div>
              </div>
            </div>

            <footer className="flex flex-wrap items-center justify-end gap-3 border-t border-secondary py-4">
              {saveError && (
                <p role="alert" className="mr-auto text-sm text-error-primary">
                  {saveError}
                </p>
              )}
              <Button type="button" color="secondary" isDisabled={saving} onPress={cancelEditing}>
                {m.settings_profile_cancel()}
              </Button>
              <Button type="button" isDisabled={saving || !changed} onPress={save}>
                {saving ? m.settings_profile_saving() : m.settings_profile_save()}
              </Button>
            </footer>
          </>
        ) : (
          <>
            {saveSuccess && (
              <p role="status" className="border-t border-secondary py-3 text-sm text-tertiary">
                <Check aria-hidden="true" className="mr-2 inline size-4 text-primary" />
                {m.settings_profile_save_success()}
              </p>
            )}
            <div className="flex min-w-0 items-center gap-4 border-t border-secondary py-6">
              <Avatar
                size="2xl"
                src={profile.avatarUrl}
                alt={profile.name}
                initials={avatarInitial(profile.name)}
                contentClassName={avatarToneClassName(profile.name)}
              />
              <div className="min-w-0">
                <p className="break-words text-lg font-semibold">{profile.name}</p>
                <p className="break-words text-sm text-tertiary">@{profile.username}</p>
              </div>
            </div>
            <dl className="grid gap-x-8 gap-y-6 border-t border-secondary pt-6 md:grid-cols-2 xl:grid-cols-3">
              <ProfileValue label={m.settings_name()} value={profile.name} />
              <ProfileValue label={m.settings_email()} value={profile.email} mono />
              <ProfileValue label={m.settings_username()} value={`@${profile.username}`} mono />
              <ProfileValue
                label={m.settings_user_description()}
                value={profile.description || "-"}
                full
              />
            </dl>
          </>
        )}
      </section>
    </div>
  );
}

function ProfileValue({
  label,
  value,
  mono = false,
  full = false,
}: {
  label: string;
  value: string;
  /** Identifiers (email, username) render in the mono font. */
  mono?: boolean;
  /** Long values (the description) span the full row. */
  full?: boolean;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", full && "md:col-span-2 xl:col-span-3")}>
      <dt className="text-sm text-tertiary">{label}</dt>
      <dd
        className={cn(
          "min-w-0 text-sm font-medium break-words whitespace-pre-wrap text-primary",
          mono && "font-mono",
        )}
      >
        {value}
      </dd>
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

  return (
    <div className="w-full px-4 pb-8 sm:px-6">
      <div className="divide-y divide-secondary border-b border-secondary">
        <PreferenceSection
          icon={<Languages aria-hidden="true" />}
          heading={m.preferences_language()}
        >
          <div className="grid gap-2 @lg/settings:grid-cols-2">
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
          <ComboBox
            aria-label={m.preferences_time_zone()}
            placeholder={m.preferences_time_zone_search_placeholder()}
            shortcut={false}
            items={timeZoneOptions}
            selectedKey={timeZone || "system"}
            onSelectionChange={(key) => {
              if (key !== null) onTimeZoneChange(key === "system" ? "" : String(key));
            }}
          >
            {(option) => <SelectItem id={option.id} label={option.label} />}
          </ComboBox>
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
          <div className="grid gap-2 @lg/settings:grid-cols-3">
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

function NotificationSettings({
  browserNotificationsEnabled,
  browserNotificationPermission,
  browserNotificationsConfigured,
  showAddToHomeScreenGuide,
  onBrowserNotificationsChange,
  onEnableBrowserNotifications,
  onTestBrowserNotification,
}: SettingsContentProps) {
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testSent, setTestSent] = useState(false);
  const status = !browserNotificationsConfigured
    ? m.preferences_browser_notifications_unavailable()
    : browserNotificationPermission === "unsupported"
      ? m.preferences_browser_notifications_unsupported()
      : browserNotificationPermission === "denied"
        ? m.preferences_browser_notifications_blocked()
        : browserNotificationsEnabled
          ? m.preferences_browser_notifications_on()
          : m.preferences_browser_notifications_off();

  return (
    <div className="w-full space-y-6 px-4 pb-8 sm:px-6">
      <section className="border-b border-secondary">
        <div className="flex items-start justify-between gap-5 py-5">
          <div className="min-w-0">
            <h2 className="font-semibold">{m.notifications_push_title()}</h2>
            <p className="mt-1 text-sm text-tertiary">{m.notifications_push_description()}</p>
          </div>
          <Toggle
            size="md"
            className="mt-0.5"
            aria-label={m.preferences_browser_notifications()}
            isSelected={browserNotificationsEnabled}
            isDisabled={
              saving ||
              !browserNotificationsConfigured ||
              browserNotificationPermission === "unsupported"
            }
            onChange={async (isSelected) => {
              setSaving(true);
              setTestSent(false);
              try {
                await onBrowserNotificationsChange(isSelected);
              } finally {
                setSaving(false);
              }
            }}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3 border-t border-secondary py-4">
          <span className="mr-auto text-sm text-tertiary">{status}</span>
          {browserNotificationsEnabled &&
            browserNotificationsConfigured &&
            browserNotificationPermission === "default" && (
              <Button
                type="button"
                color="secondary"
                size="sm"
                isDisabled={saving}
                onPress={async () => {
                  setSaving(true);
                  try {
                    await onEnableBrowserNotifications();
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                {m.preferences_browser_notifications_allow_browser()}
              </Button>
            )}
          {browserNotificationsEnabled && browserNotificationsConfigured && (
            <Button
              type="button"
              color="secondary"
              size="sm"
              isDisabled={browserNotificationPermission !== "granted" || testing}
              onPress={async () => {
                setTesting(true);
                setTestSent(false);
                try {
                  setTestSent(await onTestBrowserNotification());
                } finally {
                  setTesting(false);
                }
              }}
            >
              {testing
                ? m.preferences_browser_notifications_testing()
                : m.preferences_browser_notifications_test()}
            </Button>
          )}
          {testSent && (
            <span role="status" className="text-xs text-tertiary">
              {m.preferences_browser_notifications_test_sent()}
            </span>
          )}
        </div>
      </section>
      {showAddToHomeScreenGuide && (
        <section className="rounded-xl border border-secondary bg-secondary p-5 sm:p-6">
          <h2 className="font-semibold">{m.notifications_home_screen_title()}</h2>
          <p className="mt-1 max-w-2xl text-sm text-tertiary">
            {m.notifications_home_screen_description()}
          </p>
          <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm">
            <li>{m.notifications_home_screen_share()}</li>
            <li>{m.notifications_home_screen_add()}</li>
            <li>{m.notifications_home_screen_open()}</li>
          </ol>
        </section>
      )}
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
    <section className="grid gap-4 py-6 @2xl/settings:grid-cols-[240px_minmax(0,1fr)] @2xl/settings:gap-8">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-tertiary [&_svg]:size-4">{icon}</span>
        <h3 className="text-sm font-semibold">{heading}</h3>
      </div>
      <div className="min-w-0 max-w-xl">{children}</div>
    </section>
  );
}

interface TimeZoneOption {
  id: string;
  label: string;
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
      id: "system",
      label: systemLabel,
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
    id: timeZone,
    label,
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
    <Button
      type="button"
      color="secondary"
      aria-pressed={selected}
      onPress={onClick}
      className={cn(
        "min-h-12 min-w-0 w-full justify-start gap-3 bg-primary px-4 text-left whitespace-normal shadow-xs",
        selected && "border-brand bg-brand-primary text-primary ring-1 ring-brand",
      )}
    >
      {label}
      {selected && <Check aria-hidden="true" className="ml-auto size-4" />}
    </Button>
  );
}
