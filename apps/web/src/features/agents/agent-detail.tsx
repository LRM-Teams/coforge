import { memo, useState, type FormEvent } from "react";
import {
  AlertCircle,
  Bell01 as Bell,
  CpuChip01 as Bot,
  Monitor01 as Monitor,
  Edit01 as Pencil,
  UserCircle as UserRound,
  Activity as ActivityIcon,
} from "@untitledui/icons";
import { Link } from "@tanstack/react-router";

import { cn } from "@/lib/utils";
import { useSubmitGuard } from "@/hooks/use-submit-guard";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { TextArea } from "@/components/base/textarea/textarea";
import { Select } from "@/components/base/select/select";
import { Badge } from "@/components/base/badges/badges";
import { RelativeTime } from "@/components/ui/relative-time";
import { Dialog, Modal, ModalOverlay } from "@/components/application/modals/modal";
import { DialogHeader } from "@/components/application/modals/dialog-header";
import { m } from "@/paraglide/messages";
import { localizeHref } from "@/paraglide/runtime";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";
import { isAppError } from "@/lib/app-error";
import { AgentRuntimeFields, type RuntimeOptions } from "./agent-runtime-fields";
import { updateAgentInputFromForm } from "./agent-form";
import { AGENT_DISPLAY_NAME_MAX_LENGTH, type UpdateAgentInput } from "./agent.schemas";
import { latestActivityError, type ActivityEntry } from "./agent-activity";
import { agentDisplay } from "./agent-activity-presentation";
import { AgentActivityAvatar } from "./agent-activity-avatar";
import { AgentActivityTimeline } from "./agent-activity-timeline";
import { AgentSkills, type AgentSkillsLoadResult } from "./agent-skills";
import { AgentControl } from "./agent-control";
import { AgentReminders } from "./agent-reminders";
import {
  AgentEnvironmentEditor,
  type AgentEnvironmentEditorProps,
} from "./agent-environment-editor";

type Detail = Awaited<ReturnType<typeof import("./agents.functions").getAgentDetail>>;
type AgentTab = "profile" | "activity" | "reminders";

const AGENT_TABS: ReadonlyArray<{ value: AgentTab; icon: typeof UserRound; label: () => string }> =
  [
    { value: "profile", icon: UserRound, label: () => m.agent_profile_tab() },
    { value: "activity", icon: ActivityIcon, label: () => m.agent_activity_tab() },
    { value: "reminders", icon: Bell, label: () => m.agent_reminders_tab() },
  ];

export function AgentDetail({
  detail,
  display = detail.display,
  activity = detail.activity,
  tab,
  timeZone,
  onSaveRuntimeCredential,
  onDeleteRuntimeCredential,
  onUpdate,
  onUpdateRole,
  onLoadRuntimeOptions,
  onLoadSkills,
  onExecuteControl,
  onLoadReminders = async () => ({ status: "unauthorized" }),
  environment,
  availableComputers = [],
  initialEditOpen = false,
}: {
  detail: Detail;
  /** Live display snapshot; falls back to the one loaded with the detail. */
  display?: AgentDisplaySnapshot;
  activity?: ActivityEntry[];
  tab: AgentTab;
  timeZone: string | null;
  onSaveRuntimeCredential: (apiKey: string) => Promise<void>;
  onDeleteRuntimeCredential: () => Promise<void>;
  onUpdate: (input: UpdateAgentInput) => Promise<void>;
  /** Present only for a Workspace owner/admin viewer; changes the Agent's own management authority. */
  onUpdateRole?: (input: { agentId: string; role: "admin" | "member" }) => Promise<void>;
  onLoadRuntimeOptions: (computerId: string) => Promise<RuntimeOptions>;
  onLoadSkills?: () => Promise<AgentSkillsLoadResult>;
  onExecuteControl?: Parameters<typeof AgentControl>[0]["onExecute"];
  onLoadReminders?: Parameters<typeof AgentReminders>[0]["onLoad"];
  environment?: AgentEnvironmentEditorProps;
  availableComputers?: ReadonlyArray<{ id: string; displayName: string; online?: boolean }>;
  initialEditOpen?: boolean;
}) {
  const view = agentDisplay(display);
  const online = view.isOnline;
  const statusLabel = view.label;
  const latestError = latestActivityError(activity);
  return (
    <main className="flex h-svh max-h-svh min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-primary px-4 pt-5 md:px-8 md:pt-8">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-4 pb-6">
        <div className="flex min-w-0 items-center gap-3">
          <AgentActivityAvatar
            agent={detail}
            size="lg"
            display={display}
            activity={activity}
            timeZone={timeZone}
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="break-words text-2xl font-semibold md:text-3xl">
                {detail.displayName}
              </h1>
              <Badge color={online ? "success" : "gray"} size="sm">
                {statusLabel}
              </Badge>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-tertiary">
              <span className="break-all">@{detail.name}</span>
              <span aria-hidden="true">·</span>
              <span>
                {m.agent_profile_created()}{" "}
                <RelativeTime value={detail.createdAt} timeZone={timeZone} />
              </span>
            </div>
          </div>
        </div>
        <Button href={localizeHref(`/messages/${detail.id}`)} size="md" color="secondary">
          {m.agent_private_chat()}
        </Button>
      </div>
      <nav
        className="flex shrink-0 gap-5 overflow-x-auto border-b border-secondary md:gap-6"
        aria-label={m.agent_detail_tabs()}
      >
        {AGENT_TABS.map(({ value, icon: Icon, label }) => (
          <Link
            key={value}
            to="/agents/$agentId"
            params={{ agentId: detail.id }}
            search={{ tab: value, edit: false }}
            aria-current={tab === value ? "page" : undefined}
            className={`inline-flex shrink-0 items-center gap-2 border-b-2 px-0.5 pb-3 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand ${tab === value ? "border-brand text-brand-secondary" : "border-transparent text-tertiary hover:border-brand hover:text-brand-secondary"}`}
          >
            <Icon className="size-4 shrink-0" aria-hidden="true" />
            {label()}
          </Link>
        ))}
      </nav>
      <section
        aria-label={AGENT_TABS.find((candidate) => candidate.value === tab)?.label()}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-8"
      >
        {tab === "profile" && latestError && (
          <div
            role="alert"
            className="mt-6 flex items-start gap-3 rounded-xl border border-error_subtle bg-error-primary p-4 text-sm"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-error-primary" />
            <div>
              <p className="font-medium text-error-primary">{m.agent_latest_error()}</p>
              <p className="mt-1 text-tertiary">{latestError.detail}</p>
            </div>
          </div>
        )}
        {tab === "profile" ? (
          <Profile
            detail={detail}
            onSaveRuntimeCredential={onSaveRuntimeCredential}
            onDeleteRuntimeCredential={onDeleteRuntimeCredential}
            onUpdate={onUpdate}
            onUpdateRole={onUpdateRole}
            onLoadRuntimeOptions={onLoadRuntimeOptions}
            onLoadSkills={onLoadSkills}
            onExecuteControl={onExecuteControl}
            environment={environment}
            availableComputers={availableComputers}
            initialEditOpen={initialEditOpen}
          />
        ) : tab === "activity" ? (
          <AgentActivityTimeline activity={activity} timeZone={timeZone} />
        ) : (
          <AgentReminders
            agentId={detail.id}
            owned={detail.ownedByCurrentUser}
            timeZone={timeZone}
            onLoad={onLoadReminders}
          />
        )}
      </section>
    </main>
  );
}

const Profile = memo(function Profile({
  detail,
  onSaveRuntimeCredential,
  onDeleteRuntimeCredential,
  onUpdate,
  onUpdateRole,
  onLoadRuntimeOptions,
  onLoadSkills,
  onExecuteControl,
  environment,
  availableComputers,
  initialEditOpen,
}: {
  detail: Detail;
  onSaveRuntimeCredential: (apiKey: string) => Promise<void>;
  onDeleteRuntimeCredential: () => Promise<void>;
  onUpdate: (input: UpdateAgentInput) => Promise<void>;
  /** Present only for a Workspace owner/admin viewer; changes the Agent's own management authority. */
  onUpdateRole?: (input: { agentId: string; role: "admin" | "member" }) => Promise<void>;
  onLoadRuntimeOptions: (computerId: string) => Promise<RuntimeOptions>;
  onLoadSkills?: () => Promise<AgentSkillsLoadResult>;
  onExecuteControl?: Parameters<typeof AgentControl>[0]["onExecute"];
  environment?: AgentEnvironmentEditorProps;
  availableComputers: ReadonlyArray<{ id: string; displayName: string; online?: boolean }>;
  initialEditOpen: boolean;
}) {
  const [runtimeDialogOpen, setRuntimeDialogOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(initialEditOpen);
  const [saving, guard] = useSubmitGuard();
  const [savingRole, guardRole] = useSubmitGuard();
  const [editError, setEditError] = useState("");
  const [runtimeError, setRuntimeError] = useState("");
  const [selectedComputerId, setSelectedComputerId] = useState(
    detail.computerId ?? availableComputers[0]?.id ?? "",
  );
  const { runtime, provider, model, reasoning } = detail.runtimeConfig;
  const providerId = provider.kind === "coforge" ? provider.providerId : "";
  const canConfigureCredential = detail.ownedByCurrentUser && Boolean(providerId);
  const runtimeLabel =
    runtime === RUNTIME_PROVIDER.COFORGE ? m.agent_provider_pi_builtin() : providerLabel(runtime);
  const modelFields = [
    { label: m.agent_form_model(), value: model || m.agent_form_provider_default() },
    { label: m.agent_form_reasoning(), value: reasoning || m.agent_form_provider_default() },
  ];
  const nameMatchesDisplayName = detail.name === detail.displayName;
  const fields = [
    { label: m.agent_profile_id(), value: detail.id, breakAll: true },
    { label: m.agent_form_username(), value: `@${detail.name}` },
    ...(nameMatchesDisplayName
      ? []
      : [{ label: m.agent_profile_display_name(), value: detail.displayName }]),
    ...(detail.description
      ? [{ label: m.agent_profile_description(), value: detail.description }]
      : []),
    { label: m.agent_profile_owner(), value: `@${detail.owner.username}` },
  ];
  return (
    <div className="divide-y divide-secondary">
      <section className="py-6">
        <div className="flex items-start justify-between gap-4">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Bot className="size-4" /> {m.agent_profile_basic()}
          </h2>
          {detail.ownedByCurrentUser && (
            <Button
              size="sm"
              color="secondary"
              iconLeading={Pencil}
              onPress={() => setEditOpen(true)}
            >
              {m.agent_edit()}
            </Button>
          )}
        </div>
        <dl className="mt-5 grid gap-x-8 gap-y-6 md:grid-cols-2 xl:grid-cols-3">
          {fields.map(({ label, value, breakAll }) => (
            <div key={label} className="min-w-0">
              <dt className="text-sm text-tertiary">{label}</dt>
              <dd
                className={cn(
                  "mt-1 min-w-0 text-sm font-medium whitespace-pre-wrap text-primary",
                  breakAll ? "break-all" : "break-words",
                )}
              >
                {value}
              </dd>
            </div>
          ))}
        </dl>
        {detail.canManageAgentRole && onUpdateRole && (
          <div className="mt-5 max-w-xs">
            <Select
              aria-label="Agent role"
              selectedKey={detail.role === "admin" ? "admin" : "member"}
              isDisabled={savingRole}
              onSelectionChange={(key) => {
                const role = key === "admin" ? "admin" : "member";
                if (role === detail.role) return;
                void guardRole(() => onUpdateRole({ agentId: detail.id, role }));
              }}
            >
              <Select.Item id="member" label="Member" />
              <Select.Item id="admin" label="Admin" />
            </Select>
          </div>
        )}
      </section>

      <ModalOverlay
        isOpen={editOpen}
        onOpenChange={(open: boolean) => {
          if (saving) return;
          setEditOpen(open);
          if (open) setEditError("");
        }}
      >
        <Modal className="w-[calc(100vw-2rem)] max-w-lg">
          <Dialog>
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                await guard(async () => {
                  setEditError("");
                  try {
                    await onUpdate(
                      updateAgentInputFromForm(form, {
                        agentId: detail.id,
                        computerId: selectedComputerId,
                      }),
                    );
                    setEditOpen(false);
                  } catch (cause) {
                    setEditError(
                      isAppError(cause) && cause.errorId === "agent-api-key-required"
                        ? m.agent_form_api_key_required()
                        : isAppError(cause) && cause.errorId === "agent-runtime-unavailable"
                          ? m.agent_form_runtime_unavailable()
                          : isAppError(cause) && cause.errorId === "agent-computer-required"
                            ? m.agent_form_computer_required()
                            : m.agent_update_error(),
                    );
                  }
                });
              }}
            >
              <DialogHeader
                title={m.agent_edit_title()}
                description={m.agent_edit_description()}
                onClose={() => setEditOpen(false)}
              />
              <div className="grid gap-4 px-6 py-6 sm:grid-cols-2">
                <Input
                  label={m.agent_form_display_name()}
                  name="displayName"
                  isReadOnly={detail.isWeeklyReportAssistant}
                  defaultValue={detail.displayName}
                  maxLength={AGENT_DISPLAY_NAME_MAX_LENGTH}
                  className="min-w-0 sm:col-span-2"
                />
                <Input
                  label={m.agent_form_username()}
                  isReadOnly
                  value={`@${detail.name}`}
                  hint={m.agent_form_username_locked_hint()}
                  className="min-w-0 sm:col-span-2"
                />
                <TextArea
                  label={m.agent_profile_description()}
                  name="description"
                  rows={4}
                  defaultValue={detail.description}
                  className="min-w-0 sm:col-span-2"
                />
                {detail.computerId ? (
                  <Input
                    label={m.agent_form_computer()}
                    isReadOnly
                    value={detail.computer?.label ?? detail.computerId}
                    className="min-w-0 sm:col-span-2"
                  />
                ) : (
                  <Select
                    name="computerId"
                    isRequired
                    label={m.agent_form_computer()}
                    selectedKey={selectedComputerId}
                    onSelectionChange={(key) => setSelectedComputerId(String(key ?? ""))}
                    className="min-w-0 sm:col-span-2"
                  >
                    {availableComputers.map((computer) => (
                      <Select.Item
                        key={computer.id}
                        id={computer.id}
                        label={computer.displayName}
                        aria-label={`${computer.displayName}, ${computer.online ? m.computer_status_online() : m.computer_status_offline()}`}
                        icon={
                          <span
                            role="img"
                            aria-label={
                              computer.online
                                ? m.computer_status_online()
                                : m.computer_status_offline()
                            }
                            className={`size-2 shrink-0 rounded-full ${computer.online ? "bg-online" : "bg-offline"}`}
                          />
                        }
                      />
                    ))}
                  </Select>
                )}
                <AgentRuntimeFields
                  open={editOpen}
                  computerId={selectedComputerId}
                  credentialConfigured={Boolean(detail.runtimeCredential)}
                  initial={{
                    provider: runtime,
                    modelProvider: detail.runtimeConfig.modelProvider,
                    model,
                    reasoning,
                  }}
                  onLoad={onLoadRuntimeOptions}
                />
                {editError && (
                  <p role="alert" className="text-sm text-error-primary sm:col-span-2">
                    {editError}
                  </p>
                )}
              </div>
              <div className="flex justify-end gap-3 border-t border-secondary px-6 py-4">
                <Button
                  type="button"
                  size="md"
                  color="secondary"
                  isDisabled={saving}
                  onPress={() => setEditOpen(false)}
                >
                  {m.controls_cancel()}
                </Button>
                <Button type="submit" size="md" isDisabled={saving}>
                  {m.agent_runtime_save()}
                </Button>
              </div>
            </form>
          </Dialog>
        </Modal>
      </ModalOverlay>
      <section className="py-6">
        <h2 className="flex items-start gap-2 text-base font-semibold">
          <Monitor className="size-4" />
          {m.agent_profile_computer()}
        </h2>
        <div className="mt-5 min-w-0">
          <p className="text-sm font-medium break-words text-primary">
            {detail.computer?.label ?? m.agent_computer_unnamed()}
          </p>
          <p className="mt-1 text-sm text-tertiary">
            {detail.computer ? m.agent_computer_observed() : m.agent_computer_not_observed()}
          </p>
        </div>
      </section>
      <section className="py-6">
        <div className="flex items-start justify-between gap-4">
          <h2 className="font-semibold">{m.agent_runtime_config()}</h2>
          {canConfigureCredential && (
            <Button
              size="sm"
              color="secondary"
              iconLeading={Pencil}
              onPress={() => setRuntimeDialogOpen(true)}
            >
              {m.agent_runtime_edit()}
            </Button>
          )}
        </div>
        <div className="mt-5 grid min-w-0 gap-x-8 gap-y-6 md:grid-cols-2 xl:grid-cols-3">
          <RuntimeField label={m.agent_runtime_field()} value={runtimeLabel} />
          {provider.kind === "coforge" && (
            <>
              <RuntimeField
                label={m.agent_runtime_provider_field()}
                value={providerId || m.agent_form_provider_default()}
              />
              <RuntimeField
                label={m.agent_runtime_api_key({ provider: providerId })}
                value={
                  detail.ownedByCurrentUser
                    ? detail.runtimeCredential?.hint || m.agent_runtime_api_key_not_configured()
                    : m.agent_runtime_api_key_private()
                }
              />
            </>
          )}
          {modelFields.map((field) => (
            <RuntimeField key={field.label} {...field} />
          ))}
        </div>
      </section>
      {detail.ownedByCurrentUser && environment && (
        <AgentEnvironmentEditor key={`environment:${detail.id}`} {...environment} />
      )}
      {detail.ownedByCurrentUser && onLoadSkills && (
        <AgentSkills
          key={`${detail.id}:${detail.computerId ?? ""}:${JSON.stringify(detail.runtimeConfig)}`}
          resetKey={`${detail.id}:${detail.computerId ?? ""}:${JSON.stringify(detail.runtimeConfig)}`}
          onLoad={onLoadSkills}
        />
      )}
      {detail.ownedByCurrentUser && onExecuteControl && (
        <AgentControl
          key={`control:${detail.id}`}
          agentId={detail.id}
          agentName={detail.displayName}
          onExecute={onExecuteControl}
        />
      )}

      <ModalOverlay
        isOpen={runtimeDialogOpen}
        onOpenChange={(open: boolean) => {
          if (saving) return;
          setRuntimeDialogOpen(open);
          if (open) setRuntimeError("");
        }}
      >
        <Modal className="w-[calc(100vw-2rem)] max-w-lg">
          <Dialog>
            {({ close }) => (
              <form
                onSubmit={async (event: FormEvent<HTMLFormElement>) => {
                  event.preventDefault();
                  const apiKey = String(new FormData(event.currentTarget).get("apiKey") ?? "");
                  await guard(async () => {
                    setRuntimeError("");
                    try {
                      await onSaveRuntimeCredential(apiKey);
                      setRuntimeDialogOpen(false);
                    } catch {
                      setRuntimeError(m.agent_runtime_save_error());
                    }
                  });
                }}
              >
                <DialogHeader
                  title={m.agent_runtime_edit_title()}
                  description={m.agent_runtime_edit_description()}
                  onClose={close}
                />
                <div className="grid gap-4 px-6 py-6 sm:grid-cols-2">
                  <RuntimeField label={m.agent_runtime_field()} value={runtimeLabel} />
                  {runtimeError && (
                    <p role="alert" className="text-sm text-error-primary sm:col-span-2">
                      {runtimeError}
                    </p>
                  )}
                  {providerId && (
                    <>
                      <RuntimeField label={m.agent_runtime_provider_field()} value={providerId} />
                      <Input
                        label={m.agent_runtime_api_key({ provider: providerId })}
                        name="apiKey"
                        type="password"
                        isRequired
                        minLength={8}
                        autoComplete="new-password"
                        placeholder={m.agent_runtime_api_key_placeholder({ provider: providerId })}
                        hint={
                          detail.runtimeCredential
                            ? m.agent_runtime_api_key_configured({
                                hint: detail.runtimeCredential.hint,
                              })
                            : undefined
                        }
                        className="min-w-0 sm:col-span-2"
                      />
                    </>
                  )}
                  {modelFields.map((field) => (
                    <RuntimeField key={field.label} {...field} />
                  ))}
                </div>
                <div className="flex justify-between gap-3 border-t border-secondary px-6 py-4">
                  <div>
                    {detail.runtimeCredential && (
                      <Button
                        type="button"
                        size="md"
                        color="tertiary"
                        isDisabled={saving}
                        onPress={() =>
                          guard(async () => {
                            setRuntimeError("");
                            try {
                              await onDeleteRuntimeCredential();
                              setRuntimeDialogOpen(false);
                            } catch {
                              setRuntimeError(m.agent_runtime_delete_error());
                            }
                          })
                        }
                      >
                        {m.agent_runtime_delete_key()}
                      </Button>
                    )}
                  </div>
                  <div className="flex gap-3">
                    <Button
                      type="button"
                      size="md"
                      color="secondary"
                      isDisabled={saving}
                      onPress={() => setRuntimeDialogOpen(false)}
                    >
                      {m.controls_cancel()}
                    </Button>
                    <Button type="submit" size="md" isDisabled={saving}>
                      {saving ? m.agent_runtime_saving() : m.agent_runtime_save()}
                    </Button>
                  </div>
                </div>
              </form>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </div>
  );
});

function providerLabel(provider: string) {
  if (provider === "pi") return "Pi";
  if (provider === "codex") return "Codex";
  if (provider === "claude-code") return "Claude Code";
  if (provider === "kiro") return "Kiro";
  return provider;
}

function RuntimeField({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-sm text-tertiary">{label}</p>
      <p className="mt-1 min-w-0 text-sm font-medium whitespace-pre-wrap break-words text-primary">
        {value || "—"}
      </p>
    </div>
  );
}
