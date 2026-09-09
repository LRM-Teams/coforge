import { useState, type FormEvent } from "react";
import {
  Activity as ActivityIcon,
  AlertCircle,
  Bell,
  Bot,
  Monitor,
  Pencil,
  UserRound,
  X,
} from "lucide-react";
import { Link } from "@tanstack/react-router";

import { Avatar } from "@/components/ui/avatar";
import { Button, buttonVariants } from "@/components/ui/button";
import { RelativeTime } from "@/components/ui/relative-time";
import { useAppToast } from "@/components/ui/toast";
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogDescription,
  DialogPopup,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import { m } from "@/paraglide/messages";
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
    <main className="flex h-svh max-h-svh min-h-0 flex-1 flex-col overflow-hidden p-4 sm:p-5 md:p-6">
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar
            people={[{ name: detail.displayName }]}
            size="lg"
            online={online}
            statusLabel={statusLabel}
          />
          <div className="min-w-0">
            <h1 className="break-words text-2xl font-semibold tracking-tight">
              {detail.displayName}
            </h1>
            <p className="text-sm text-muted-foreground">@{detail.name}</p>
            <p className="mt-1 text-xs text-muted-foreground">{statusLabel}</p>
          </div>
        </div>
        <Link
          to="/messages/$agentId"
          params={{ agentId: detail.id }}
          className={buttonVariants({ variant: "outline" })}
        >
          {m.agent_private_chat()}
        </Link>
      </div>
      <nav className="mt-6 flex shrink-0 gap-1 border-b" aria-label={m.agent_detail_tabs()}>
        {(["profile", "activity", "reminders"] as const).map((value) => (
          <Link
            key={value}
            to="/agents/$agentId"
            params={{ agentId: detail.id }}
            search={{ tab: value }}
            className={`inline-flex items-center gap-1 border-b-2 px-2 py-2 text-sm font-medium sm:gap-2 sm:px-4 ${tab === value ? "border-primary text-foreground" : "border-transparent text-muted-foreground"}`}
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
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        {tab === "profile" && latestError && (
          <div
            role="alert"
            className="mt-6 flex items-start gap-3 rounded-xl border border-destructive/50 bg-destructive/5 p-4 text-sm"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div>
              <p className="font-medium text-destructive-text">{m.agent_latest_error()}</p>
              <p className="mt-1 text-muted-foreground">{latestError.detail}</p>
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
  const toast = useAppToast();
  const runtime = configValue(detail.runtimeConfig, "runtime");
  const providerKind = nestedConfigValue(detail.runtimeConfig, "provider", "kind");
  const providerId = nestedConfigValue(detail.runtimeConfig, "provider", "providerId");
  const canConfigureCredential =
    detail.ownedByCurrentUser && providerKind === "coforge" && Boolean(providerId);
  const fields = [
    { label: m.agent_profile_id(), value: detail.id },
    { label: m.agent_profile_name(), value: detail.name },
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
    <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-2">
      <section className="rounded-xl border bg-card p-5">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 font-semibold">
            <Bot className="size-4" /> {m.agent_profile_basic()}
          </h2>
          {detail.ownedByCurrentUser && (
            <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
              <Pencil />
              {m.agent_edit()}
            </Button>
          )}
        </div>
        <dl className="mt-4 grid gap-4">
          {fields.map(({ label, value }) => (
            <div key={label}>
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="mt-1 break-words text-sm">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogPortal keepMounted>
          <DialogBackdrop />
          <DialogPopup>
            <form
              onSubmit={async (event) => {
                event.preventDefault();
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
                } catch (cause) {
                  toast.error(m.agent_update_error(), cause);
                } finally {
                  setSaving(false);
                }
              }}
            >
              <div className="px-6 pt-6">
                <DialogTitle>{m.agent_edit_title()}</DialogTitle>
                <DialogDescription>{m.agent_edit_description()}</DialogDescription>
              </div>
              <div className="grid gap-3 px-6 py-6">
                <label>
                  {m.agent_form_name()}
                  <input
                    name="name"
                    required
                    defaultValue={detail.name}
                    className="mt-1 h-9 w-full rounded-md border px-3"
                  />
                </label>
                <label>
                  {m.agent_profile_description()}
                  <textarea
                    name="description"
                    required
                    defaultValue={detail.description}
                    className="mt-1 w-full rounded-md border p-3"
                  />
                </label>
                <label className="sm:col-span-2">
                  {m.agent_form_computer()}
                  <input
                    readOnly
                    value={detail.computer?.label ?? detail.computerId ?? ""}
                    className="mt-1 h-9 w-full rounded-md border bg-muted px-3"
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
              </div>
              <div className="flex justify-end gap-3 border-t px-6 py-4">
                <Button type="button" variant="outline" onClick={() => setEditOpen(false)}>
                  {m.controls_cancel()}
                </Button>
                <Button type="submit" disabled={saving}>
                  {m.agent_runtime_save()}
                </Button>
              </div>
            </form>
          </DialogPopup>
        </DialogPortal>
      </Dialog>
      <section className="rounded-xl border bg-card p-5">
        <h2 className="flex items-center gap-2 font-semibold">
          <Monitor className="size-4" />
          {m.agent_profile_computer()}
        </h2>
        <p className="mt-4 text-sm">{detail.computer?.label ?? m.agent_computer_unnamed()}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {detail.computer ? m.agent_computer_observed() : m.agent_computer_not_observed()}
        </p>
      </section>
      <section className="rounded-xl border bg-card p-5 lg:col-span-2">
        <div className="flex items-center justify-between gap-4">
          <h2 className="font-semibold">{m.agent_runtime_config()}</h2>
          {canConfigureCredential && (
            <Button size="sm" variant="outline" onClick={() => setRuntimeDialogOpen(true)}>
              <Pencil aria-hidden="true" />
              {m.agent_runtime_edit()}
            </Button>
          )}
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
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

      <Dialog open={runtimeDialogOpen} onOpenChange={setRuntimeDialogOpen}>
        <DialogPortal keepMounted>
          <DialogBackdrop />
          <DialogPopup>
            <form
              onSubmit={async (event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                setSaving(true);
                try {
                  const apiKey = String(new FormData(event.currentTarget).get("apiKey") ?? "");
                  await onSaveRuntimeCredential(apiKey);
                  setRuntimeDialogOpen(false);
                } catch (cause) {
                  toast.error(m.agent_runtime_save_error(), cause);
                } finally {
                  setSaving(false);
                }
              }}
            >
              <div className="flex items-start justify-between gap-6 px-6 pt-6">
                <div>
                  <DialogTitle>{m.agent_runtime_edit_title()}</DialogTitle>
                  <DialogDescription className="mt-2">
                    {m.agent_runtime_edit_description()}
                  </DialogDescription>
                </div>
                <DialogClose
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={m.controls_close()}
                    >
                      <X aria-hidden="true" />
                    </Button>
                  }
                />
              </div>
              <div className="grid gap-4 px-6 py-6 sm:grid-cols-2">
                <RuntimeField
                  label={m.agent_runtime_field()}
                  value={providerKind === "coforge" ? m.agent_provider_pi_builtin() : runtime}
                />
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
                        className="h-9 rounded-md border bg-background px-3 outline-none focus:ring-2 focus:ring-ring/30"
                      />
                      {detail.runtimeCredential && (
                        <span className="text-xs text-muted-foreground">
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
              <div className="flex justify-between gap-3 border-t px-6 py-4">
                <div>
                  {detail.runtimeCredential && (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={async () => {
                        try {
                          await onDeleteRuntimeCredential();
                          setRuntimeDialogOpen(false);
                        } catch (cause) {
                          toast.error(m.agent_runtime_delete_error(), cause);
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
                    variant="outline"
                    onClick={() => setRuntimeDialogOpen(false)}
                  >
                    {m.controls_cancel()}
                  </Button>
                  <Button type="submit" disabled={saving}>
                    {saving ? m.agent_runtime_saving() : m.agent_runtime_save()}
                  </Button>
                </div>
              </div>
            </form>
          </DialogPopup>
        </DialogPortal>
      </Dialog>
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
    <label className="grid min-w-0 gap-1.5 text-sm">
      {label}
      <input
        value={value}
        readOnly
        className="h-9 min-w-0 rounded-md border bg-muted px-3 text-muted-foreground outline-none"
      />
    </label>
  );
}

function Activity({ activity, timeZone }: { activity: ActivityEntry[]; timeZone: string | null }) {
  if (!activity.length)
    return (
      <div className="mt-6 rounded-xl border border-dashed p-10 text-center">
        <p className="font-medium">{m.agent_activity_empty()}</p>
        <p className="mt-1 text-sm text-muted-foreground">{m.agent_activity_empty_description()}</p>
      </div>
    );
  return (
    <ol className="mt-6 list-none divide-y">
      {activity.map((entry) => (
        <li
          key={`${entry.launchId}:${entry.clientSeq}`}
          className="grid gap-1 py-2 sm:grid-cols-[max-content_max-content_minmax(0,1fr)] sm:items-start sm:gap-3"
        >
          <RelativeTime
            value={new Date(entry.observedAtMs)}
            timeZone={timeZone}
            className="whitespace-nowrap text-xs tabular-nums text-muted-foreground sm:pt-0.5"
          />
          <span className="flex items-center gap-2 font-medium">
            <span
              aria-hidden="true"
              className={`size-1.5 shrink-0 rounded-full ${activityDotClass(entry.detailKind, entry.level)}`}
            />
            <span className={entry.level === "error" ? "text-destructive-text" : undefined}>
              {activityLabel(entry.detailKind, entry.level)}
            </span>
          </span>
          {showsActivityMessage(entry.detailKind) && (
            <p
              className={`whitespace-pre-wrap break-words text-sm ${["running_command", "tool_started"].includes(entry.detailKind) ? "select-text font-mono" : ""} ${entry.level === "error" ? "text-destructive-text" : "text-muted-foreground"}`}
            >
              {entry.detail}
              {entry.entries?.map((item, index) =>
                item.kind !== "tool_start" ? (
                  <span key={index} className="block">
                    {item.text}
                  </span>
                ) : null,
              )}
              {entry.runtimeError && (
                <span className="mt-1 block text-xs opacity-75">
                  {entry.runtimeError.errorClass} · {entry.runtimeError.errorReason}
                </span>
              )}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}
