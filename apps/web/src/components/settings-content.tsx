import { useSubmitGuard } from "@/hooks/use-submit-guard";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  BellRinging01 as BellRing,
  Check,
  ChevronLeft,
  Clock as Clock3,
  Translate01 as Languages,
  LayoutLeft,
  MessageSquare01 as MessagesSquare,
  Moon01 as Moon,
  Share01,
  Sliders01 as SlidersHorizontal,
  Sun,
  SunSetting01 as SunMoon,
  Type01 as TypeIcon,
  Upload01 as Upload,
  UserCircle as UserRound,
  Users01 as Users,
} from "@untitledui/icons";

import { PageHeader } from "@/components/layout/page-header";
import { Avatar } from "@/components/base/avatar/avatar";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Input } from "@/components/base/input/input";
import { TextArea } from "@/components/base/textarea/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { ComboBox } from "@/components/base/select/combobox";
import { Select } from "@/components/base/select/select";
import { SelectItem } from "@/components/base/select/select-item";
import { Toggle } from "@/components/base/toggle/toggle";
import { ButtonGroup, ButtonGroupItem } from "@/components/base/button-group/button-group";
import { WorkspaceMembersPanel } from "@/features/workspaces/workspace-members-panel";
import { GitHubSettings } from "@/features/integrations/github-settings";
import { TEXT_SIZE_OPTIONS, type TextSizeValue } from "@/features/settings/text-size";
import {
  isConversationOpenMode,
  type ConversationOpenMode,
} from "@/features/settings/conversation-open-mode";
import { avatarInitial, avatarToneClassName } from "@/lib/avatar-tone";
import { cn } from "@/lib/utils";
import { isAppError } from "@/lib/app-error";
import { m } from "@/paraglide/messages";

type Locale = "en" | "zh-CN";
type Theme = "system" | "light" | "dark";
type SettingsSection = "account" | "members" | "preferences" | "notifications" | "integrations";

interface SettingsContentProps {
  /** Controlled section; falls back to internal state when omitted (tests, previews). */
  section?: SettingsSection;
  githubCallbackError?: boolean;
  githubWrongAccount?: boolean;
  onSectionChange?: (section: SettingsSection) => void;
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
  railLabels: boolean;
  textSize: TextSizeValue;
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
  onRailLabelsChange: (show: boolean) => void;
  onTextSizeChange: (size: TextSizeValue) => void;
  onTimeZoneChange: (timeZone: string) => void;
  conversationOpenMode: ConversationOpenMode;
  onConversationOpenModeChange: (mode: ConversationOpenMode) => void;
  onBrowserNotificationsChange: (enabled: boolean) => Promise<void>;
  onEnableBrowserNotifications: () => Promise<void>;
  onTestBrowserNotification: () => Promise<boolean>;
}

export function SettingsPending() {
  return (
    <main aria-busy="true" className="flex h-svh min-w-0">
      <p role="status" className="sr-only">
        {m.settings_loading()}
      </p>
      <nav className="flex w-full min-w-0 flex-col overflow-hidden border-r border-secondary bg-primary md:w-60 md:shrink-0">
        <PageHeader heading={m.settings_title()} />
        <div className="space-y-5 overflow-y-auto p-3">
          {[
            {
              label: m.settings_personal_group(),
              items: [
                m.settings_account(),
                m.settings_preferences(),
                m.settings_notifications(),
                m.settings_integrations(),
              ],
            },
            { label: m.settings_workspace_group(), items: [m.settings_members()] },
          ].map((group) => (
            <SettingsNavigationGroup key={group.label} label={group.label}>
              {group.items.map((label) => (
                <li key={label} className="flex h-9 items-center gap-3 px-3 text-sm font-medium">
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
            <header className="flex min-h-12 items-center pb-4">
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
  const [internalSection, setInternalSection] = useState<SettingsSection>("account");
  const section = props.section ?? internalSection;
  const [showList, setShowList] = useState(props.section !== "integrations");
  const sectionLabel =
    section === "account"
      ? m.settings_account()
      : section === "members"
        ? m.settings_members()
        : section === "preferences"
          ? m.settings_preferences()
          : section === "integrations"
            ? m.settings_integrations()
            : m.settings_notifications();

  function selectSection(next: SettingsSection) {
    setInternalSection(next);
    props.onSectionChange?.(next);
    setShowList(false);
  }

  return (
    <main className="flex h-svh min-w-0">
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
              icon={UserRound}
              label={m.settings_account()}
              onClick={() => selectSection("account")}
            />
            <SettingsNavigationButton
              active={section === "preferences"}
              icon={SlidersHorizontal}
              label={m.settings_preferences()}
              onClick={() => selectSection("preferences")}
            />
            <SettingsNavigationButton
              active={section === "notifications"}
              icon={BellRing}
              label={m.settings_notifications()}
              onClick={() => selectSection("notifications")}
            />
            <SettingsNavigationButton
              active={section === "integrations"}
              icon={Share01}
              label={m.settings_integrations()}
              onClick={() => selectSection("integrations")}
            />
          </SettingsNavigationGroup>
          <SettingsNavigationGroup label={m.settings_workspace_group()}>
            <SettingsNavigationButton
              active={section === "members"}
              icon={Users}
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
                  : section === "integrations"
                    ? m.settings_integrations()
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
            ) : section === "integrations" ? (
              <GitHubSettings
                callbackError={props.githubCallbackError ?? false}
                wrongAccount={props.githubWrongAccount ?? false}
              />
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
      <h2 className="px-3 pt-2 pb-2 text-xs font-semibold text-quaternary uppercase tracking-wide">
        {label}
      </h2>
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
  icon: React.FC<{ className?: string }>;
  label: string;
  onClick: () => void;
}) {
  return (
    <li>
      <Button
        type="button"
        color="tertiary"
        iconLeading={icon}
        aria-current={active ? "page" : undefined}
        onPress={onClick}
        className={cn(
          "h-9 w-full min-w-0 justify-start rounded-lg px-3 text-sm font-medium",
          active && "bg-active text-brand-secondary",
        )}
      >
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
  const [saving, guard] = useSubmitGuard();
  const [pendingAvatar, setPendingAvatar] = useState<File | null>(null);
  const [removeAvatar, setRemoveAvatar] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  // Show the just-picked image immediately, before it is uploaded on Save. Without this the
  // preview keeps showing the saved `profile.avatarUrl` until a save round-trips, which reads as
  // "the avatar didn't change". Object URLs must be revoked to avoid leaking the blob.
  const [pendingAvatarPreview, setPendingAvatarPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!pendingAvatar) {
      setPendingAvatarPreview(null);
      return;
    }
    const url = URL.createObjectURL(pendingAvatar);
    setPendingAvatarPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [pendingAvatar]);
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
    await guard(async () => {
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
      }
    });
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
        <header className="flex min-h-12 items-center justify-between gap-4 py-3">
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
                  src={removeAvatar ? null : (pendingAvatarPreview ?? profile.avatarUrl)}
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
                {/* Both identities are visible while editing, but only one is editable: the
                 * display name is what teammates read, and the username is the fixed handle
                 * mentions resolve against, so it is shown as a value rather than a field
                 * nobody can submit. "Display name" replaces the old ambiguous "Name". */}
                <Input
                  label={m.settings_display_name()}
                  value={name}
                  maxLength={80}
                  isDisabled={saving}
                  hideRequiredIndicator
                  onChange={setName}
                />
                <div className="flex min-w-0 flex-col gap-1.5">
                  <span className="text-sm font-medium text-secondary">
                    {m.settings_username()}
                  </span>
                  <p className="min-w-0 truncate text-sm font-medium text-primary">
                    @{profile.username}
                  </p>
                  <p className="text-xs text-tertiary">{m.settings_username_fixed()}</p>
                </div>

                <div className="flex flex-col gap-1.5 md:col-span-2 xl:col-span-3">
                  <TextArea
                    label={m.settings_user_description()}
                    value={description}
                    maxLength={280}
                    rows={4}
                    placeholder={m.settings_user_description_placeholder()}
                    isDisabled={saving}
                    hideRequiredIndicator
                    onChange={setDescription}
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
              <ProfileValue label={m.settings_display_name()} value={profile.name} />
              <ProfileValue label={m.settings_email()} value={profile.email} />
              <ProfileValue label={m.settings_username()} value={`@${profile.username}`} />
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
  full = false,
}: {
  label: string;
  value: string;
  /** Long values (the description) span the full row. */
  full?: boolean;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", full && "md:col-span-2 xl:col-span-3")}>
      <dt className="text-sm text-tertiary">{label}</dt>
      <dd className="min-w-0 text-sm font-medium break-words whitespace-pre-wrap text-primary">
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
  railLabels,
  onRailLabelsChange,
  textSize,
  onTextSizeChange,
  onTimeZoneChange,
  conversationOpenMode,
  onConversationOpenModeChange,
}: SettingsContentProps) {
  const timeZoneOptions = getTimeZoneOptions(m.preferences_system());
  const textSizeLabels: Record<TextSizeValue, string> = {
    sm: m.preferences_text_size_small(),
    default: m.preferences_text_size_default(),
    lg: m.preferences_text_size_large(),
    xl: m.preferences_text_size_extra_large(),
    xxl: m.preferences_text_size_huge(),
  };

  return (
    <div className="w-full px-4 pb-8 sm:px-6">
      <div className="divide-y divide-secondary border-b border-secondary">
        <PreferenceSection
          icon={<Languages aria-hidden="true" />}
          heading={m.preferences_language()}
        >
          <ButtonGroup
            aria-label={m.preferences_language()}
            size="sm"
            selectedKeys={[locale]}
            disallowEmptySelection
            onSelectionChange={(keys) => {
              const next = [...keys][0];
              if (next !== undefined) onLocaleChange(String(next) as typeof locale);
            }}
          >
            <ButtonGroupItem id="en">{m.preferences_english()}</ButtonGroupItem>
            <ButtonGroupItem id="zh-CN">{m.preferences_chinese()}</ButtonGroupItem>
          </ButtonGroup>
        </PreferenceSection>

        <PreferenceSection icon={<Clock3 aria-hidden="true" />} heading={m.preferences_time_zone()}>
          <ComboBox
            aria-label={m.preferences_time_zone()}
            className="max-w-sm"
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
          <ButtonGroup
            aria-label={m.preferences_appearance()}
            size="sm"
            selectedKeys={[theme]}
            disallowEmptySelection
            onSelectionChange={(keys) => {
              const next = [...keys][0];
              if (next !== undefined) onThemeChange(String(next) as typeof theme);
            }}
          >
            <ButtonGroupItem id="system" iconLeading={SunMoon}>
              {m.preferences_system()}
            </ButtonGroupItem>
            <ButtonGroupItem id="light" iconLeading={Sun}>
              {m.preferences_light()}
            </ButtonGroupItem>
            <ButtonGroupItem id="dark" iconLeading={Moon}>
              {m.preferences_dark()}
            </ButtonGroupItem>
          </ButtonGroup>
        </PreferenceSection>

        <PreferenceSection
          icon={<TypeIcon aria-hidden="true" />}
          heading={m.preferences_text_size()}
        >
          <Select
            aria-label={m.preferences_text_size()}
            className="max-w-sm"
            value={textSize}
            onChange={(key) => {
              if (key !== null) onTextSizeChange(String(key) as TextSizeValue);
            }}
          >
            {TEXT_SIZE_OPTIONS.map(({ value, percent }) => (
              <SelectItem
                key={value}
                id={value}
                label={textSizeLabels[value]}
                supportingText={
                  value === "default"
                    ? m.preferences_text_size_default_hint()
                    : m.preferences_text_size_percent({ percent })
                }
              />
            ))}
          </Select>
        </PreferenceSection>

        <PreferenceSection
          icon={<LayoutLeft aria-hidden="true" />}
          heading={m.preferences_sidebar()}
        >
          <Toggle
            size="sm"
            className="max-w-full"
            label={m.preferences_rail_labels()}
            isSelected={railLabels}
            onChange={onRailLabelsChange}
          />
        </PreferenceSection>

        <PreferenceSection
          icon={<MessagesSquare aria-hidden="true" />}
          heading={m.preferences_conversations()}
        >
          <Select
            aria-label={m.preferences_conversation_open_mode()}
            className="max-w-sm"
            value={conversationOpenMode}
            onChange={(key) => {
              const mode = String(key);
              if (isConversationOpenMode(mode)) onConversationOpenModeChange(mode);
            }}
          >
            <SelectItem id="newest-read" label={m.preferences_open_newest_read()} />
            <SelectItem id="first-unread" label={m.preferences_open_first_unread()} />
            <SelectItem id="newest-unread" label={m.preferences_open_newest_unread()} />
          </Select>
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
  const [saving, guardSave] = useSubmitGuard();
  const [testing, guardTest] = useSubmitGuard();
  const [testSent, setTestSent] = useState(false);
  const unavailableReason = !browserNotificationsConfigured
    ? m.notifications_push_unconfigured()
    : browserNotificationPermission === "unsupported"
      ? m.preferences_browser_notifications_unsupported()
      : browserNotificationPermission === "denied"
        ? m.preferences_browser_notifications_blocked()
        : null;
  const toggleDisabled =
    saving || !browserNotificationsConfigured || browserNotificationPermission === "unsupported";
  const showActions = browserNotificationsEnabled && browserNotificationsConfigured;

  return (
    <div className="w-full px-4 pb-8 sm:px-6">
      <div className="divide-y divide-secondary border-b border-secondary">
        <div className="py-2">
          <div className="flex min-h-14 items-center justify-between gap-5">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-primary">{m.notifications_push_title()}</h2>
              <p className="mt-0.5 text-sm text-tertiary">
                {unavailableReason ?? m.notifications_push_description()}
              </p>
            </div>
            <Toggle
              size="md"
              className="shrink-0"
              aria-label={m.preferences_browser_notifications()}
              isSelected={browserNotificationsEnabled}
              isDisabled={toggleDisabled}
              onChange={(isSelected) => {
                setTestSent(false);
                void guardSave(() => onBrowserNotificationsChange(isSelected));
              }}
            />
          </div>
          {showActions && (
            <div className="flex flex-wrap items-center gap-3 pb-3">
              {browserNotificationPermission === "default" && (
                <Button
                  type="button"
                  color="secondary"
                  size="sm"
                  isDisabled={saving}
                  onPress={() => void guardSave(() => onEnableBrowserNotifications())}
                >
                  {m.preferences_browser_notifications_allow_browser()}
                </Button>
              )}
              <Button
                type="button"
                color="secondary"
                size="sm"
                isDisabled={browserNotificationPermission !== "granted" || testing}
                onPress={() => {
                  setTestSent(false);
                  void guardTest(async () => setTestSent(await onTestBrowserNotification()));
                }}
              >
                {testing
                  ? m.preferences_browser_notifications_testing()
                  : m.preferences_browser_notifications_test()}
              </Button>
              {testSent && (
                <span role="status" className="text-xs text-tertiary">
                  {m.preferences_browser_notifications_test_sent()}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
      {showAddToHomeScreenGuide && (
        <div className="mt-6 flex items-start gap-3 rounded-lg border border-secondary bg-secondary px-4 py-4">
          <Share01 aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-tertiary" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-primary">
              {m.notifications_home_screen_title()}
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-tertiary">
              {m.notifications_home_screen_description()}
            </p>
            <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-secondary">
              <li>{m.notifications_home_screen_share()}</li>
              <li>{m.notifications_home_screen_add()}</li>
              <li>{m.notifications_home_screen_open()}</li>
            </ol>
          </div>
        </div>
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
    <section className="flex flex-col gap-4 py-6">
      <div className="flex items-center gap-2">
        <span className="text-tertiary [&_svg]:size-4">{icon}</span>
        <h3 className="text-sm font-semibold text-primary">{heading}</h3>
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
