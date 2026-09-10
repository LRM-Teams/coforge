import { useRef, useState, type FormEvent } from "react";
import {
  Activity as ActivityIcon,
  AlertCircle,
  Bell01 as Bell,
  CpuChip01 as Bot,
  Monitor01 as Monitor,
  Edit01 as Pencil,
  UserCircle as UserRound,
  XClose as X,
} from "@untitledui/icons";
import { Link } from "@tanstack/react-router";
import { Heading, Text } from "react-aria-components";

import { Avatar } from "@/components/base/avatar/avatar";
import { avatarInitial, avatarToneClassName } from "@/lib/avatar-tone";
import { cn } from "@/lib/utils";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { RelativeTime } from "@/components/ui/relative-time";
import { Dialog, Modal, ModalOverlay } from "@/components/application/modals/modal";
import { m } from "@/paraglide/messages";
import { localizeHref } from "@/paraglide/runtime";
import { AgentRuntimeFields, type RuntimeOptions } from "./agent-runtime-fields";
import type { UpdateAgentInput } from "./agent.schemas";
import { latestActivityError, type ActivityEntry } from "./agent-activity";
import {
  activityLabel,
  activityDotClass,
  showsActivityMessage,
} from "./agent-activity-presentation";
import { AgentSkills, type AgentSkillsLoadResult } from "./agent-skills";
import { AgentControl } from "./agent-control";
import { AgentReminders } from "./agent-reminders";

type Detail = Awaited<ReturnType<typeof import("./agents.functions").getAgentDetail>>;

export function AgentDetail({
  detail,
  activity = detail.activity,
  tab,
  timeZone,
  onSaveRuntimeCredential,
  onDeleteRuntimeCredential,
  onUpdate,
  onLoadRuntimeOptions,
  onLoadSkills,
  onExecuteControl,
  onLoadReminders = async () => ({ status: "unauthorized" }),
}: {
  detail: Detail;
  activity?: ActivityEntry[];
  tab: "profile" | "activity" | "reminders";
  timeZone: string | null;
  onSaveRuntimeCredential: (apiKey: string) => Promise<void>;
  onDeleteRuntimeCredential: () => Promise<void>;
  onUpdate: (input: UpdateAgentInput) => Promise<void>;
  onLoadRuntimeOptions: (computerId: string) => Promise<RuntimeOptions>;
  onLoadSkills?: () => Promise<AgentSkillsLoadResult>;
  onExecuteControl?: Parameters<typeof AgentControl>[0]["onExecute"];
  onLoadReminders?: Parameters<typeof AgentReminders>[0]["onLoad"];
}) {
  const online = detail.status.value === "unknown" ? undefined : detail.status.value === "active";
  const statusLabel =
    detail.status.value === "unknown"
      ? m.agent_status_unknown()
      : online
        ? m.agent_status_online()
        : m.agent_status_offline();
  const latestError = latestActivityError(activity);
  return (
    <main className="flex h-svh max-h-svh min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-primary px-4 pt-5 md:px-8 md:pt-8">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-4 pb-6">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar
            size="lg"
            alt={detail.displayName}
            initials={avatarInitial(detail.displayName)}
            contentClassName={avatarToneClassName(detail.displayName)}
            status={online === undefined ? undefined : online ? "online" : "offline"}
          />
          <div className="min-w-0">
            <h1 className="break-words text-2xl font-semibold md:text-3xl">{detail.displayName}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-tertiary">
              <p className="break-all">@{detail.name}</p>
              <p className="border-l border-secondary pl-3">{statusLabel}</p>
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
        {(["profile", "activity", "reminders"] as const).map((value) => (
          <Link
            key={value}
            to="/agents/$agentId"
            params={{ agentId: detail.id }}
            search={{ tab: value }}
            aria-current={tab === value ? "page" : undefined}
            className={`inline-flex shrink-0 items-center gap-2 border-b-2 px-0.5 pb-3 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand ${tab === value ? "border-brand text-brand-secondary" : "border-transparent text-tertiary hover:border-brand hover:text-brand-secondary"}`}
          >
            {value === "profile" && <UserRound className="size-4 shrink-0" aria-hidden="true" />}
            {value === "activity" && (
              <ActivityIcon className="size-4 shrink-0" aria-hidden="true" />
            )}
            {value === "reminders" && <Bell className="size-4 shrink-0" aria-hidden="true" />}
            {value === "profile"
              ? m.agent_profile_tab()
              : value === "activity"
                ? m.agent_activity_tab()
                : m.agent_reminders_tab()}
          </Link>
        ))}
      </nav>
      <section
        aria-label={
          tab === "profile"
            ? m.agent_profile_tab()
            : tab === "activity"
              ? m.agent_activity_tab()
              : m.agent_reminders_tab()
        }
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
            timeZone={timeZone}
            onSaveRuntimeCredential={onSaveRuntimeCredential}
            onDeleteRuntimeCredential={onDeleteRuntimeCredential}
            onUpdate={onUpdate}
            onLoadRuntimeOptions={onLoadRuntimeOptions}
            onLoadSkills={onLoadSkills}
            onExecuteControl={onExecuteControl}
          />
        ) : tab === "activity" ? (
          <Activity activity={activity} timeZone={timeZone} />
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

function Profile({
  detail,
  timeZone,
  onSaveRuntimeCredential,
  onDeleteRuntimeCredential,
  onUpdate,
  onLoadRuntimeOptions,
  onLoadSkills,
  onExecuteControl,
}: {
  detail: Detail;
  timeZone: string | null;
  onSaveRuntimeCredential: (apiKey: string) => Promise<void>;
  onDeleteRuntimeCredential: () => Promise<void>;
  onUpdate: (input: UpdateAgentInput) => Promise<void>;
  onLoadRuntimeOptions: (computerId: string) => Promise<RuntimeOptions>;
  onLoadSkills?: () => Promise<AgentSkillsLoadResult>;
  onExecuteControl?: Parameters<typeof AgentControl>[0]["onExecute"];
}) {
  const [runtimeDialogOpen, setRuntimeDialogOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [editError, setEditError] = useState("");
  const [runtimeError, setRuntimeError] = useState("");
  const runtime = configValue(detail.runtimeConfig, "runtime");
  const providerKind = nestedConfigValue(detail.runtimeConfig, "provider", "kind");
  const providerId = nestedConfigValue(detail.runtimeConfig, "provider", "providerId");
  const canConfigureCredential =
    detail.ownedByCurrentUser && providerKind === "coforge" && Boolean(providerId);
  const fields = [
    { label: m.agent_profile_id(), value: detail.id, mono: true },
    { label: m.agent_profile_name(), value: detail.name, mono: true },
    { label: m.agent_profile_display_name(), value: detail.displayName },
    ...(detail.description
      ? [{ label: m.agent_profile_description(), value: detail.description }]
      : []),
    { label: m.agent_profile_owner(), value: `@${detail.owner.username}` },
    {
      label: m.agent_profile_created(),
      value: <RelativeTime value={detail.createdAt} timeZone={timeZone} />,
    },
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
          {fields.map(({ label, value, mono }) => (
            <div key={label} className="min-w-0">
              <dt className="text-sm text-tertiary">{label}</dt>
              <dd
                className={cn(
                  "mt-1 min-w-0 text-sm font-medium whitespace-pre-wrap break-words text-primary",
                  mono && "font-mono",
                )}
              >
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <ModalOverlay
        isOpen={editOpen}
        onOpenChange={(open: boolean) => {
          if (savingRef.current) return;
          setEditOpen(open);
          if (open) setEditError("");
        }}
      >
        <Modal className="w-[calc(100vw-2rem)] max-w-lg">
          <Dialog>
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                if (savingRef.current) return;
                savingRef.current = true;
                setEditError("");
                setSaving(true);
                const form = new FormData(event.currentTarget);
                try {
                  await onUpdate({
                    agentId: detail.id,
                    name: String(form.get("name") ?? ""),
                    description: String(form.get("description") ?? ""),
                    provider: runtimeProviderValue(form.get("provider")),
                    modelProvider: String(form.get("modelProvider") ?? ""),
                    model: String(form.get("model") ?? ""),
                    reasoning: String(form.get("reasoning") ?? ""),
                  });
                  setEditOpen(false);
                } catch {
                  setEditError(m.agent_update_error());
                } finally {
                  savingRef.current = false;
                  setSaving(false);
                }
              }}
            >
              <div className="px-6 pt-6">
                <Heading slot="title" className="text-lg font-semibold text-primary">
                  {m.agent_edit_title()}
                </Heading>
                <Text slot="description" className="mt-2 text-sm text-tertiary">
                  {m.agent_edit_description()}
                </Text>
              </div>
              <div className="grid gap-5 px-6 py-6 text-sm font-medium">
                <label>
                  {m.agent_form_name()}
                  <input
                    name="name"
                    required
                    defaultValue={detail.name}
                    className="mt-1.5 h-10 w-full rounded-lg border border-secondary bg-primary px-3 font-normal shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  />
                </label>
                <label>
                  {m.agent_profile_description()}
                  <textarea
                    name="description"
                    required
                    rows={4}
                    defaultValue={detail.description}
                    className="mt-1.5 w-full rounded-lg border border-secondary bg-primary p-3 font-normal leading-6 shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  />
                </label>
                <label className="sm:col-span-2">
                  {m.agent_form_computer()}
                  <input
                    readOnly
                    value={detail.computer?.label ?? detail.computerId ?? ""}
                    className="mt-1.5 h-10 w-full rounded-lg border border-secondary bg-secondary px-3 font-normal shadow-xs"
                  />
                </label>
                <AgentRuntimeFields
                  open={editOpen}
                  computerId={detail.computerId ?? ""}
                  initial={{
                    provider: runtimeProviderValue(runtime),
                    modelProvider: configValue(detail.runtimeConfig, "modelProvider"),
                    model: configValue(detail.runtimeConfig, "model"),
                    reasoning: configValue(detail.runtimeConfig, "reasoning"),
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
          <RuntimeField
            label={m.agent_runtime_field()}
            value={providerKind === "coforge" ? m.agent_provider_pi_builtin() : runtime}
          />
          {providerKind === "coforge" && (
            <>
              <RuntimeField
                label={m.agent_runtime_provider_field()}
                value={providerId || m.agent_form_provider_default()}
              />
              <RuntimeField
                label={m.agent_runtime_api_key()}
                value={
                  detail.ownedByCurrentUser
                    ? detail.runtimeCredential?.hint || m.agent_runtime_api_key_not_configured()
                    : m.agent_runtime_api_key_private()
                }
              />
            </>
          )}
          <RuntimeField
            label={m.agent_form_model()}
            value={configValue(detail.runtimeConfig, "model") || m.agent_form_provider_default()}
          />
          <RuntimeField
            label={m.agent_form_reasoning()}
            value={
              configValue(detail.runtimeConfig, "reasoning") || m.agent_form_provider_default()
            }
          />
        </div>
      </section>
      {detail.ownedByCurrentUser && onLoadSkills && (
        <AgentSkills
          key={`${detail.id}:${detail.computerId ?? ""}:${JSON.stringify(detail.runtimeConfig)}`}
          resetKey={`${detail.id}:${detail.computerId ?? ""}:${JSON.stringify(detail.runtimeConfig)}`}
          onLoad={onLoadSkills}
        />
      )}
      {detail.ownedByCurrentUser && onExecuteControl && (
        <AgentControl
          key={detail.id}
          agentId={detail.id}
          agentName={detail.displayName}
          onExecute={onExecuteControl}
        />
      )}

      <ModalOverlay
        isOpen={runtimeDialogOpen}
        onOpenChange={(open: boolean) => {
          if (savingRef.current) return;
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
                  if (savingRef.current) return;
                  savingRef.current = true;
                  setRuntimeError("");
                  setSaving(true);
                  try {
                    const apiKey = String(new FormData(event.currentTarget).get("apiKey") ?? "");
                    await onSaveRuntimeCredential(apiKey);
                    setRuntimeDialogOpen(false);
                  } catch {
                    setRuntimeError(m.agent_runtime_save_error());
                  } finally {
                    savingRef.current = false;
                    setSaving(false);
                  }
                }}
              >
                <div className="flex items-start justify-between gap-6 px-6 pt-6">
                  <div>
                    <Heading slot="title" className="text-lg font-semibold text-primary">
                      {m.agent_runtime_edit_title()}
                    </Heading>
                    <Text slot="description" className="mt-2 text-sm text-tertiary">
                      {m.agent_runtime_edit_description()}
                    </Text>
                  </div>
                  <ButtonUtility
                    type="button"
                    aria-label={m.controls_close()}
                    icon={X}
                    size="sm"
                    color="tertiary"
                    onClick={close}
                  />
                </div>
                <div className="grid gap-4 px-6 py-6 sm:grid-cols-2">
                  <RuntimeField
                    label={m.agent_runtime_field()}
                    value={providerKind === "coforge" ? m.agent_provider_pi_builtin() : runtime}
                  />
                  {runtimeError && (
                    <p role="alert" className="text-sm text-error-primary sm:col-span-2">
                      {runtimeError}
                    </p>
                  )}
                  {providerKind === "coforge" && providerId && (
                    <>
                      <RuntimeField label={m.agent_runtime_provider_field()} value={providerId} />
                      <label className="grid gap-1.5 text-sm sm:col-span-2">
                        {m.agent_runtime_api_key()}
                        <input
                          name="apiKey"
                          type="password"
                          required
                          minLength={8}
                          autoComplete="new-password"
                          placeholder={m.agent_runtime_api_key_placeholder()}
                          className="h-10 rounded-lg border border-secondary bg-primary px-3 shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-brand"
                        />
                        {detail.runtimeCredential && (
                          <span className="text-xs text-tertiary">
                            {m.agent_runtime_api_key_configured({
                              hint: detail.runtimeCredential.hint,
                            })}
                          </span>
                        )}
                      </label>
                    </>
                  )}
                  <RuntimeField
                    label={m.agent_form_model()}
                    value={
                      configValue(detail.runtimeConfig, "model") || m.agent_form_provider_default()
                    }
                  />
                  <RuntimeField
                    label={m.agent_form_reasoning()}
                    value={
                      configValue(detail.runtimeConfig, "reasoning") ||
                      m.agent_form_provider_default()
                    }
                  />
                </div>
                <div className="flex justify-between gap-3 border-t border-secondary px-6 py-4">
                  <div>
                    {detail.runtimeCredential && (
                      <Button
                        type="button"
                        size="md"
                        color="tertiary"
                        isDisabled={saving}
                        onPress={async () => {
                          if (savingRef.current) return;
                          savingRef.current = true;
                          setRuntimeError("");
                          setSaving(true);
                          try {
                            await onDeleteRuntimeCredential();
                            setRuntimeDialogOpen(false);
                          } catch {
                            setRuntimeError(m.agent_runtime_delete_error());
                          } finally {
                            savingRef.current = false;
                            setSaving(false);
                          }
                        }}
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
}

function runtimeProviderValue(value: FormDataEntryValue | null): UpdateAgentInput["provider"] {
  if (value === "pi" || value === "codex" || value === "claude-code") return value;
  return "coforge";
}

function configValue(config: unknown, field: string) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return "";
  const value = Reflect.get(config, field);
  return typeof value === "string" ? value : "";
}

function nestedConfigValue(config: unknown, field: string, nestedField: string) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return "";
  const nested = Reflect.get(config, field);
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return "";
  const value = Reflect.get(nested, nestedField);
  return typeof value === "string" ? value : "";
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

function Activity({ activity, timeZone }: { activity: ActivityEntry[]; timeZone: string | null }) {
  if (!activity.length)
    return (
      <div className="my-8 flex flex-col items-center rounded-xl border border-secondary px-6 py-12 text-center">
        <span className="mb-4 rounded-xl border border-secondary p-3 shadow-xs">
          <ActivityIcon aria-hidden="true" className="size-6 text-tertiary" />
        </span>
        <p className="font-medium">{m.agent_activity_empty()}</p>
        <p className="mt-1 max-w-md text-sm leading-6 text-tertiary">
          {m.agent_activity_empty_description()}
        </p>
      </div>
    );
  return (
    <ol className="mt-6 list-none divide-y divide-secondary rounded-xl border border-secondary px-4 md:px-6">
      {activity.map((entry) => (
        <li
          key={`${entry.launchId}:${entry.clientSeq}`}
          className="grid gap-2 py-4 md:grid-cols-[7rem_10rem_minmax(0,1fr)] md:items-start md:gap-5"
        >
          <RelativeTime
            value={new Date(entry.observedAtMs)}
            timeZone={timeZone}
            className="whitespace-nowrap text-xs tabular-nums text-tertiary sm:pt-0.5"
          />
          <span className="flex items-center gap-2 text-sm font-semibold">
            <span
              aria-hidden="true"
              className={`size-1.5 shrink-0 rounded-full ${activityDotClass(entry.detailKind, entry.level)}`}
            />
            <span className={entry.level === "error" ? "text-error-primary" : undefined}>
              {activityLabel(entry.detailKind, entry.level)}
            </span>
          </span>
          {showsActivityMessage(entry.detailKind) && (
            <p
              className={`whitespace-pre-wrap break-words text-sm ${["running_command", "tool_started"].includes(entry.detailKind) ? "select-text font-mono" : ""} ${entry.level === "error" ? "text-error-primary" : "text-tertiary"}`}
            >
              {entry.detail}
              {entry.entries?.map((item, index) =>
                item.kind !== "tool_start" ? (
                  <span key={index} className="block">
                    {item.text}
                  </span>
                ) : null,
              )}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}
