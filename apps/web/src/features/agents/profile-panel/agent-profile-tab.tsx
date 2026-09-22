import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Edit01,
  Play,
  RefreshCcw01 as RotateCcw,
  Stop,
  Trash01,
  Upload01,
} from "@untitledui/icons";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { Avatar } from "@/components/base/avatar/avatar";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Select } from "@/components/base/select/select";
import { HoverPopover } from "@/components/ui/hover-popover";
import { RelativeTime } from "@/components/ui/relative-time";
import { StatusDot } from "@/components/ui/status-dot";
import { Tooltip, TooltipTrigger } from "@/components/base/tooltip/tooltip";
import { avatarInitial, avatarToneClassName } from "@/lib/avatar-tone";
import { formatDateForDisplay } from "@/lib/dates";
import { m } from "@/paraglide/messages";
import { getLocale } from "@/paraglide/runtime";
import { runtimeProviderLabel } from "@/features/agents/runtime-provider-display";
import { RuntimeProviderMark } from "@/features/agents/runtime-provider-mark";
import { computerIcon } from "@/features/computers/computer-identity";
import { RuntimeUsage, UsageHealthDot } from "@/features/computers/runtime-usage";
import { useAgentContextReport } from "@/features/agents/agent-context-report";
import { AgentContextPopoverContent } from "@/features/agents/agent-context-popover";
import type { AgentRuntimeControls } from "@/features/agents/agent-runtime-controls";
import type { getAgentProfile } from "@/features/agents/agents.functions";
import { AgentSkills, type AgentSkillsLoadResult } from "@/features/agents/agent-skills";
import { AGENT_VISIBILITY, type AgentVisibility } from "@/features/agents/agent-visibility";
import { InlineEditField, SECTION_CAPTION_CLASS, SUBFIELD_LABEL_CLASS } from "./inline-edit-field";

/** Values are never shown in the chip; the dot count hints at length without revealing it. */
function maskEnvValue(value: string) {
  return "•".repeat(Math.min(value.length, 8));
}

type AgentProfile = Awaited<ReturnType<typeof getAgentProfile>>;

/** A small chip-style badge for Runtime / Model / Reasoning and the Role field — the prototype's
 * `.chip`; the app has no separate chip primitive, so this reuses the official `Badge` at
 * `color="gray"`, the same "short fact" vocabulary `docs/ui-guidelines.md` §9 already uses. */
function FactBadge({
  children,
  icon,
  mono = false,
}: {
  children: ReactNode;
  icon?: ReactNode;
  mono?: boolean;
}) {
  return (
    <Badge color="gray" size="md" className={`gap-1.5 font-medium ${mono ? "font-mono" : ""}`}>
      {icon}
      {children}
    </Badge>
  );
}

/**
 * The Agent's current context-window usage, next to the Runtime badge — display only (ADR 0050):
 * nothing here triggers on any threshold, and it never colors by how full the window is. Hidden
 * entirely by the caller when there is no reading. The tooltip's observed time uses the same
 * `formatDateForDisplay` helper (workspace time zone, viewer locale) the Runtime usage popover's
 * `RelativeTime` already renders through.
 *
 * For a Claude Code Agent the badge is also the trigger of the context-breakdown popover (ADR
 * 0051): hover shows the last stored report with the same auto-refresh-once/Refresh pattern the
 * Runtime usage popover uses. Other runtimes keep the plain badge + tooltip.
 */
function ContextUsageBadge({
  agentId,
  contextUsage,
  timeZone,
  supportsContextReport,
  computerOnline,
}: {
  agentId: string;
  contextUsage: { usedTokens: number; windowTokens: number; observedAtMs: number };
  timeZone: string | null;
  /** `runtime === RUNTIME_PROVIDER.CLAUDE_CODE` at the call site; only Claude Code has a
   * composition to read. */
  supportsContextReport: boolean;
  computerOnline?: boolean;
}) {
  const locale = getLocale();
  const percent = Math.min(
    100,
    Math.max(0, Math.round((contextUsage.usedTokens / contextUsage.windowTokens) * 100)),
  );
  const numberFormat = new Intl.NumberFormat(locale);
  const badge = <FactBadge>{m.agent_context_usage_badge({ percent })}</FactBadge>;
  const tooltipText = m.agent_context_usage_tooltip({
    used: numberFormat.format(contextUsage.usedTokens),
    window: numberFormat.format(contextUsage.windowTokens),
    time: formatDateForDisplay(new Date(contextUsage.observedAtMs), timeZone, locale),
  });
  const context = useAgentContextReport(agentId, {
    enabled: supportsContextReport,
    computerOnline,
  });
  const [openCount, setOpenCount] = useState(0);
  const refreshButtonWrapRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (openCount > 0) refreshButtonWrapRef.current?.querySelector("button")?.focus();
  }, [openCount]);

  if (!supportsContextReport) {
    return (
      <Tooltip title={tooltipText}>
        <TooltipTrigger>{badge}</TooltipTrigger>
      </Tooltip>
    );
  }

  return (
    <HoverPopover
      label={m.agent_context_usage_tooltip({
        used: numberFormat.format(contextUsage.usedTokens),
        window: numberFormat.format(contextUsage.windowTokens),
        time: formatDateForDisplay(new Date(contextUsage.observedAtMs), timeZone, locale),
      })}
      trigger={badge}
      triggerClassName="-m-1 inline-flex rounded-lg p-1 outline-none hover:bg-primary_hover data-focus-visible:ring-2 data-focus-visible:ring-brand"
      className="p-4 text-sm"
      working={context.scanning}
      onOpen={() => setOpenCount((count) => count + 1)}
    >
      <AgentContextPopoverContent
        header={tooltipText}
        data={context.data}
        scanning={context.scanning}
        scanFailed={context.scanFailed}
        computerOnline={computerOnline}
        timeZone={timeZone}
        onRefresh={context.refresh}
        refreshButtonWrapRef={refreshButtonWrapRef}
      />
    </HoverPopover>
  );
}

/**
 * The Agent profile panel's Profile tab body: label-over-value throughout, no left/right fact
 * rows, no leading row icons (`docs/ui-guidelines.md` §4's field-grid style, per the approved
 * prototype). Managers/owners get the pencils, INFO's Role editor, RUNTIME CONFIG's credential
 * dialog and the ACTIONS section; everyone else sees a read-only Profile.
 */
export function AgentProfileTab({
  profile,
  timeZone,
  canManage,
  controls,
  onSaveDisplayName,
  onSaveDescription,
  onAvatarChange,
  onAvatarRemove,
  onSaveRole,
  onRequestVisibilityChange,
  runtimeCredentialDialog,
  onStartRuntimeEdit,
  onLoadSkills,
  envVars,
  onStartDelete,
  contextUsage,
}: {
  profile: NonNullable<AgentProfile>;
  timeZone: string | null;
  /** The Agent's current context-window usage (ADR 0050), or `null` when there is no reading —
   * hidden entirely in that case. Display only; nothing triggers on it. */
  contextUsage?: { usedTokens: number; windowTokens: number; observedAtMs: number } | null;
  /** `canManageAgentRole || ownedByCurrentUser` — gates every pencil, the ACTIONS section. */
  canManage: boolean;
  controls: AgentRuntimeControls;
  onSaveDisplayName: (value: string) => Promise<void>;
  onSaveDescription: (value: string) => Promise<void>;
  /** Creator-only. Omitted for every other viewer, who still sees the picture. */
  onAvatarChange?: (file: File) => Promise<void>;
  onAvatarRemove?: () => Promise<void>;
  onSaveRole?: (role: "admin" | "member") => Promise<void>;
  /** Opens the container's `AgentVisibilityConfirmDialog` for the given target visibility (ADR
   * 0059). Present only for the creator or a human Workspace owner/admin. */
  onRequestVisibilityChange?: (target: AgentVisibility) => void;
  runtimeCredentialDialog: ReactNode;
  /** Opens the container's `AgentRuntimeConfigDialog` (see `agent-profile-panel.tsx`). The
   * RUNTIME CONFIG badges below never change; only the pencil does anything. */
  onStartRuntimeEdit?: () => void;
  /** Owner-only, same as the old Agent detail page's Skills section. Omitted for a viewer who
   * does not own the Agent. */
  onLoadSkills?: () => Promise<AgentSkillsLoadResult>;
  /** Opens the container's `AgentDeleteDialog` (ADR 0044). Present only when the viewer holds
   * Raft's `deleteAgents` capability and this Agent is a delete target at all. */
  onStartDelete?: () => void;
  /** Owner-only read view of the Agent's launch environment overrides, masked; editing happens in
   * the Runtime config dialog's Advanced disclosure (`agent-runtime-config-dialog.tsx`).
   * `undefined` for a viewer who does not own the Agent (the GET is owner-only); an owner whose
   * query has not resolved yet gets `{}`, same empty-state copy as a genuinely empty map. */
  envVars?: Record<string, string>;
}) {
  const { runtime, model, reasoning } = profile.runtimeConfig;
  const canEditRuntime = canManage && Boolean(profile.computer) && Boolean(onStartRuntimeEdit);
  const runtimeLabel = runtimeProviderLabel(runtime);
  const runtimeIcon = <RuntimeProviderMark provider={runtime} className="size-3.5" />;
  const creatorName = profile.owner.displayName?.trim() || profile.owner.username;
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [avatarError, setAvatarError] = useState("");
  const [avatarBusy, setAvatarBusy] = useState(false);
  // Same rule as the Workspace members panel: the display name leads, the handle follows only
  // when it says something the display name does not.
  const creatorHandle = profile.owner.username;
  const creatorShowsHandle = creatorName !== creatorHandle;
  const ComputerIcon = profile.computer
    ? computerIcon({
        kind: profile.computer.kind,
        name: profile.computer.label,
        displayName: profile.computer.label,
      })
    : undefined;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <section className="border-b border-secondary px-6 py-5">
        <div className="mb-5 flex flex-wrap items-center gap-4">
          <Avatar
            size="xl"
            src={profile.avatarUrl}
            alt={profile.displayName}
            initials={avatarInitial(profile.displayName)}
            contentClassName={avatarToneClassName(profile.displayName)}
          />
          {onAvatarChange && (
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  color="secondary"
                  size="sm"
                  iconLeading={Upload01}
                  isDisabled={avatarBusy}
                  onPress={() => avatarInputRef.current?.click()}
                >
                  {m.agent_avatar_change()}
                </Button>
                <input
                  ref={avatarInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  aria-label={m.agent_avatar_change()}
                  disabled={avatarBusy}
                  className="sr-only"
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = "";
                    if (!file) return;
                    setAvatarError("");
                    setAvatarBusy(true);
                    void onAvatarChange(file)
                      .catch(() => setAvatarError(m.agent_avatar_save_error()))
                      .finally(() => setAvatarBusy(false));
                  }}
                />
                {profile.avatarUrl && onAvatarRemove && (
                  <Button
                    type="button"
                    color="tertiary"
                    size="sm"
                    isDisabled={avatarBusy}
                    onPress={() => {
                      setAvatarError("");
                      setAvatarBusy(true);
                      void onAvatarRemove()
                        .catch(() => setAvatarError(m.agent_avatar_save_error()))
                        .finally(() => setAvatarBusy(false));
                    }}
                  >
                    {m.agent_avatar_remove()}
                  </Button>
                )}
              </div>
              <p className="mt-2 text-xs text-tertiary">{m.agent_avatar_help()}</p>
              {avatarError && (
                <p role="alert" className="mt-1 text-xs text-error-primary">
                  {avatarError}
                </p>
              )}
            </div>
          )}
        </div>
        {/* No error snapshot here: the Agent's current state belongs under its name in the panel
            header, and the Activity tab is where the record lives. A raw request id next to a
            transient "model at capacity" is developer debris in a profile — Frank, 2026-09-21. */}
        <InlineEditField
          label={m.agent_profile_display_name()}
          value={profile.displayName}
          editable={canManage && !profile.isWeeklyReportAssistant}
          editLabel={m.agent_profile_edit_display_name()}
          saving={false}
          onSave={onSaveDisplayName}
        />
        <InlineEditField
          label={m.agent_profile_description()}
          value={profile.description ?? ""}
          multiline
          editable={canManage}
          editLabel={m.agent_profile_edit_description()}
          saving={false}
          onSave={onSaveDescription}
        />
      </section>

      <section className="border-b border-secondary px-6 py-5">
        <p className={SECTION_CAPTION_CLASS}>{m.agent_profile_section_info()}</p>
        <div className="mt-3 grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-3">
          <RoleField
            role={profile.role}
            onSave={profile.canManageAgentRole ? onSaveRole : undefined}
          />
          <VisibilityField
            visibility={profile.visibility}
            onRequest={profile.canChangeVisibility ? onRequestVisibilityChange : undefined}
          />
        </div>
        <div className="mt-4">
          <p className={SUBFIELD_LABEL_CLASS}>{m.agent_profile_computer()}</p>
          <p className="mt-1 flex items-center gap-1.5 text-sm font-medium text-primary">
            {ComputerIcon && (
              <ComputerIcon className="size-4 shrink-0 text-tertiary" aria-hidden="true" />
            )}
            <span className="truncate font-mono">
              {profile.computer?.label || m.agent_computer_unnamed()}
            </span>
          </p>
          {profile.computer && (
            <p className="mt-1 flex items-center gap-1.5 text-xs text-tertiary">
              <StatusDot
                tone={profile.computer.online ? "online" : "offline"}
                className="size-1.5"
              />
              {profile.computer.online
                ? m.agent_profile_computer_connected()
                : m.agent_profile_computer_offline()}
              {profile.computer.computerVersion && (
                <span className="font-mono">· {profile.computer.computerVersion}</span>
              )}
            </p>
          )}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-x-8 gap-y-4">
          <div>
            <p className={SUBFIELD_LABEL_CLASS}>{m.agent_profile_created()}</p>
            <p className="mt-1 text-sm font-medium text-primary">
              <RelativeTime value={profile.createdAt} timeZone={timeZone} />
            </p>
          </div>
          <div>
            <p className={SUBFIELD_LABEL_CLASS}>{m.agent_profile_creator()}</p>
            <p className="mt-1 flex items-center gap-1.5 text-sm font-medium text-primary">
              <Avatar
                size="xs"
                alt=""
                src={profile.owner.avatarUrl ?? undefined}
                initials={avatarInitial(creatorName)}
                contentClassName={avatarToneClassName(creatorName)}
              />
              <span className="truncate">{creatorName}</span>
              {creatorShowsHandle && (
                <span className="truncate text-sm font-normal text-tertiary">@{creatorHandle}</span>
              )}
            </p>
          </div>
        </div>
      </section>

      <section className="border-b border-secondary px-6 py-5">
        <div className="flex items-center gap-1.5">
          <p className={SECTION_CAPTION_CLASS}>{m.agent_profile_section_runtime()}</p>
          {canEditRuntime && (
            <ButtonUtility
              aria-label={m.agent_profile_edit_runtime_config()}
              tooltip={m.agent_profile_edit_runtime_config()}
              icon={Edit01}
              size="xs"
              color="tertiary"
              onClick={onStartRuntimeEdit}
            />
          )}
          {canManage && runtimeCredentialDialog}
        </div>
        <div className="mt-3 flex flex-wrap gap-x-8 gap-y-4">
          <div>
            <p className={SUBFIELD_LABEL_CLASS}>{m.agent_runtime_field()}</p>
            <p className="mt-1 flex flex-wrap items-center gap-2">
              {profile.runtimeUsageVisible && profile.computer ? (
                <RuntimeUsage
                  computerId={profile.computer.id}
                  runtime={{
                    provider: runtime,
                    displayName: runtimeLabel,
                    version: profile.runtimeVersion,
                  }}
                  computerOnline={profile.computer.online}
                  timeZone={timeZone}
                  trigger={(health) => (
                    <FactBadge icon={runtimeIcon}>
                      {runtimeLabel}
                      <UsageHealthDot health={health} />
                    </FactBadge>
                  )}
                  triggerClassName="-m-1 inline-flex rounded-lg p-1 outline-none hover:bg-primary_hover data-focus-visible:ring-2 data-focus-visible:ring-brand"
                />
              ) : (
                <FactBadge icon={runtimeIcon}>{runtimeLabel}</FactBadge>
              )}
              {contextUsage && (
                <ContextUsageBadge
                  agentId={profile.id}
                  contextUsage={contextUsage}
                  timeZone={timeZone}
                  supportsContextReport={runtime === RUNTIME_PROVIDER.CLAUDE_CODE}
                  computerOnline={profile.computer?.online}
                />
              )}
            </p>
          </div>
          <div>
            <p className={SUBFIELD_LABEL_CLASS}>{m.agent_form_model()}</p>
            <p className="mt-1">
              <FactBadge mono={Boolean(model)}>
                {model || m.agent_form_provider_default()}
              </FactBadge>
            </p>
          </div>
          <div>
            <p className={SUBFIELD_LABEL_CLASS}>{m.agent_form_reasoning()}</p>
            <p className="mt-1">
              <FactBadge>{reasoning || m.agent_form_provider_default()}</FactBadge>
            </p>
          </div>
        </div>
        {profile.ownedByCurrentUser && (
          <div className="mt-4">
            <p className={SUBFIELD_LABEL_CLASS}>{m.agent_env_title()}</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {envVars && Object.keys(envVars).length > 0 ? (
                Object.entries(envVars).map(([key, value]) => (
                  <Tooltip key={key} title={`${key}=${value}`}>
                    <TooltipTrigger>
                      <Badge color="gray" size="sm" className="font-mono">
                        {key}={maskEnvValue(value)}
                      </Badge>
                    </TooltipTrigger>
                  </Tooltip>
                ))
              ) : (
                <p className="text-sm text-tertiary italic">{m.agent_env_none()}</p>
              )}
            </div>
          </div>
        )}
      </section>

      {profile.ownedByCurrentUser && onLoadSkills && (
        <div className="border-b border-secondary px-6">
          <AgentSkills
            resetKey={`${profile.id}:${profile.computerId ?? ""}:${JSON.stringify(profile.runtimeConfig)}`}
            onLoad={onLoadSkills}
          />
        </div>
      )}

      {canManage && (
        <section className="px-6 py-5">
          <p className={SECTION_CAPTION_CLASS}>{m.agent_profile_section_actions()}</p>
          <div className="mt-3 flex flex-col gap-2">
            <Button
              color="secondary"
              className="w-full justify-center"
              iconLeading={controls.isOnline ? Stop : Play}
              isDisabled={controls.startStopBusy}
              onPress={controls.pressStartOrStop}
            >
              {controls.isOnline ? m.agent_profile_action_stop() : m.agent_profile_action_start()}
            </Button>
            <Button
              color="secondary"
              className="w-full justify-center"
              iconLeading={RotateCcw}
              onPress={() => controls.openRestart("restart")}
            >
              {m.agent_control_restart_reset_tooltip()}
            </Button>
            {onStartDelete && (
              /* A danger entry button is still a button (`docs/ui-guidelines.md` §8 危险操作), so it
               * gets the bordered red rather than bare red text. The one solid red belongs to the
               * confirm in `AgentDeleteDialog`; `mt-1` keeps a small break between the reversible
               * actions above and this one. */
              <Button
                color="secondary-destructive"
                className="mt-1 w-full justify-center"
                iconLeading={Trash01}
                onPress={onStartDelete}
              >
                {m.agent_profile_action_delete()}
              </Button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * Visibility (ADR 0059) reads as a badge, same as Role; an authorized viewer (creator or
 * Workspace owner/admin) gets a pencil that swaps it for the Select — both directions have real
 * consequences, so picking an option still opens the container's confirmation dialog rather
 * than applying immediately.
 */
/** The visibility the Select's chosen key asks for, or `null` when it asks for the current one —
 * only a real change opens the confirmation dialog. Kept pure so the no-op rule is testable
 * without rendering the Select. */
export function visibilityChangeTarget(
  current: AgentVisibility,
  key: string,
): AgentVisibility | null {
  const target = key === "private" ? AGENT_VISIBILITY.PRIVATE : AGENT_VISIBILITY.PUBLIC;
  return target === current ? null : target;
}

function VisibilityField({
  visibility,
  onRequest,
}: {
  visibility: AgentVisibility;
  onRequest?: (target: AgentVisibility) => void;
}) {
  const [editing, setEditing] = useState(false);
  const isPrivate = visibility === AGENT_VISIBILITY.PRIVATE;
  return (
    <div>
      <div className="flex items-center gap-1.5">
        <span className={SUBFIELD_LABEL_CLASS}>{m.agent_profile_visibility()}</span>
        {onRequest && !editing && (
          <ButtonUtility
            size="xs"
            color="tertiary"
            icon={Edit01}
            aria-label={m.agent_profile_edit_visibility()}
            tooltip={m.agent_profile_edit_visibility()}
            onClick={() => setEditing(true)}
          />
        )}
      </div>
      <div className="mt-1">
        {editing && onRequest ? (
          <Select
            aria-label={m.agent_profile_edit_visibility()}
            size="sm"
            selectedKey={isPrivate ? "private" : "public"}
            onSelectionChange={(key) => {
              setEditing(false);
              const target = visibilityChangeTarget(visibility, String(key));
              if (target) onRequest(target);
            }}
            className="w-36"
          >
            <Select.Item id="public" label={m.agent_visibility_label_public()} />
            <Select.Item id="private" label={m.agent_visibility_label_private()} />
          </Select>
        ) : (
          <Badge color={isPrivate ? "gray" : "brand"} size="sm">
            {isPrivate ? m.agent_visibility_label_private() : m.agent_visibility_label_public()}
          </Badge>
        )}
      </div>
    </div>
  );
}

/** Role reads as a badge; a manager's pencil swaps it for the Select until a choice is made. */
function RoleField({
  role,
  onSave,
}: {
  role: string;
  onSave?: (role: "admin" | "member") => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <div>
      <div className="flex items-center gap-1.5">
        <span className={SUBFIELD_LABEL_CLASS}>{m.agent_profile_role()}</span>
        {onSave && !editing && (
          <ButtonUtility
            size="xs"
            color="tertiary"
            icon={Edit01}
            aria-label={m.agent_profile_edit_role()}
            tooltip={m.agent_profile_edit_role()}
            onClick={() => setEditing(true)}
          />
        )}
      </div>
      <div className="mt-1">
        {editing && onSave ? (
          <Select
            aria-label={m.agent_profile_edit_role()}
            size="sm"
            selectedKey={role === "admin" ? "admin" : "member"}
            onSelectionChange={(key) => {
              setEditing(false);
              void onSave(key === "admin" ? "admin" : "member");
            }}
            className="w-36"
          >
            <Select.Item id="member" label={m.agent_role_member()} />
            <Select.Item id="admin" label={m.agent_role_admin()} />
          </Select>
        ) : (
          <Badge color="brand" size="sm">
            {role === "admin" ? m.agent_role_admin() : m.agent_role_member()}
          </Badge>
        )}
      </div>
    </div>
  );
}
