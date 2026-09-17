import { useState, type ReactNode } from "react";
import {
  AlertCircle,
  Edit01,
  Play,
  RefreshCcw01 as RotateCcw,
  StopSquare,
} from "@untitledui/icons";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import { Avatar } from "@/components/base/avatar/avatar";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Select } from "@/components/base/select/select";
import { RelativeTime } from "@/components/ui/relative-time";
import { avatarInitial, avatarToneClassName } from "@/lib/avatar-tone";
import { m } from "@/paraglide/messages";
import { agentDisplay } from "@/features/agents/agent-activity-presentation";
import {
  RUNTIME_PROVIDER_MARK,
  RUNTIME_PROVIDER_MARK_IS_COLOR_ICON,
  runtimeProviderLabel,
} from "@/features/agents/runtime-provider-display";
import { computerIcon } from "@/features/computers/computer-identity";
import type { AgentRuntimeControls } from "@/features/agents/agent-runtime-controls";
import type { getAgentProfile } from "@/features/agents/agents.functions";
import { InlineEditField, SECTION_CAPTION_CLASS, SUBFIELD_LABEL_CLASS } from "./inline-edit-field";

type AgentProfile = Awaited<ReturnType<typeof getAgentProfile>>;

/** Status labels stay English (apps/web/AGENTS.md: Activity labels are not internationalized). */
const STOPPED_LABEL = "Stopped";

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
 * The Agent profile panel's Profile tab body: label-over-value throughout, no left/right fact
 * rows, no leading row icons (`docs/ui-guidelines.md` §4's field-grid style, per the approved
 * prototype). Managers/owners get the pencils, INFO's Role editor, RUNTIME CONFIG's credential
 * dialog and the ACTIONS section; everyone else sees a read-only Profile.
 */
export function AgentProfileTab({
  profile,
  display,
  timeZone,
  canManage,
  controls,
  onGotoActivity,
  onSaveDisplayName,
  onSaveDescription,
  onSaveRole,
  runtimeCredentialDialog,
}: {
  profile: NonNullable<AgentProfile>;
  display?: AgentDisplaySnapshot;
  timeZone: string | null;
  /** `canManageAgentRole || ownedByCurrentUser` — gates every pencil, the ACTIONS section. */
  canManage: boolean;
  controls: AgentRuntimeControls;
  onGotoActivity: () => void;
  onSaveDisplayName: (value: string) => Promise<void>;
  onSaveDescription: (value: string) => Promise<void>;
  onSaveRole?: (role: "admin" | "member") => Promise<void>;
  runtimeCredentialDialog: ReactNode;
}) {
  const view = agentDisplay(display, { stopped: profile.stopped });
  const { runtime, model, reasoning } = profile.runtimeConfig;
  const runtimeLabel = runtimeProviderLabel(runtime);
  const mark = RUNTIME_PROVIDER_MARK[runtime];
  const runtimeIcon = mark ? (
    RUNTIME_PROVIDER_MARK_IS_COLOR_ICON[runtime] ? (
      <img src={mark} alt="" className="size-3.5 shrink-0" />
    ) : (
      <span
        aria-hidden="true"
        className="size-3.5 shrink-0 bg-fg-primary mask-contain mask-center mask-no-repeat"
        style={{ maskImage: `url("${mark}")`, WebkitMaskImage: `url("${mark}")` }}
      />
    )
  ) : undefined;
  const creatorName = profile.owner.displayName?.trim() || profile.owner.username;
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
        <div className="flex items-center gap-4">
          <span className="relative block shrink-0">
            <Avatar
              size="xl"
              alt=""
              initials={avatarInitial(profile.displayName)}
              contentClassName={avatarToneClassName(profile.displayName)}
            />
            <span
              aria-hidden="true"
              className={`absolute -right-0.5 -bottom-0.5 size-3.5 rounded-full border-2 border-primary ${
                view.tone === "idle"
                  ? "bg-success-solid"
                  : view.tone === "error"
                    ? "bg-error-solid"
                    : view.tone === "working" || view.tone === "thinking"
                      ? "bg-amber-500"
                      : "bg-offline"
              }`}
            />
          </span>
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 text-lg font-semibold text-primary">
              <span className="truncate">{profile.displayName}</span>
              <Badge color={view.isOnline ? "success" : "gray"} size="sm">
                {profile.stopped && !view.isOnline ? STOPPED_LABEL : view.label}
              </Badge>
            </p>
            <p className="truncate font-mono text-sm text-tertiary">@{profile.name}</p>
          </div>
        </div>
        {profile.latestError && (
          <div
            role="alert"
            className="mt-4 flex items-start gap-2.5 rounded-lg border border-error_subtle bg-error-primary px-3 py-2.5 text-sm"
          >
            <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-error-primary" />
            <div className="min-w-0">
              <p className="text-error-primary">{profile.latestError.detail}</p>
              <p className="mt-0.5 font-mono text-xs text-tertiary">{profile.latestError.id}</p>
              <Button
                color="link-color"
                size="sm"
                noTextPadding
                onPress={onGotoActivity}
                className="mt-1 h-auto p-0 font-semibold"
              >
                {m.agent_profile_view_activity()}
              </Button>
            </div>
          </div>
        )}
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
              <span
                aria-hidden="true"
                className={`size-1.5 rounded-full ${profile.computer.online ? "bg-online" : "bg-offline"}`}
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
                initials={avatarInitial(creatorName)}
                contentClassName={avatarToneClassName(creatorName)}
              />
              <span className="truncate">{creatorName}</span>
            </p>
          </div>
        </div>
      </section>

      <section className="border-b border-secondary px-6 py-5">
        <div className="flex items-center gap-1.5">
          <p className={SECTION_CAPTION_CLASS}>{m.agent_profile_section_runtime()}</p>
          {canManage && runtimeCredentialDialog}
        </div>
        <div className="mt-3 flex flex-wrap gap-x-8 gap-y-4">
          <div>
            <p className={SUBFIELD_LABEL_CLASS}>{m.agent_runtime_field()}</p>
            <p className="mt-1">
              <FactBadge icon={runtimeIcon}>{runtimeLabel}</FactBadge>
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
      </section>

      {canManage && (
        <section className="px-6 py-5">
          <p className={SECTION_CAPTION_CLASS}>{m.agent_profile_section_actions()}</p>
          <div className="mt-3 flex flex-col gap-2">
            <Button
              color="secondary"
              className="w-full justify-center"
              iconLeading={controls.isOnline ? StopSquare : Play}
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
          </div>
        </section>
      )}
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
