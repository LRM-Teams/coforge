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

import { MobileNavigationButton } from "@/components/layout/mobile-navigation";
import { Button, buttonVariants } from "@/components/ui/button";
import { RelativeTime } from "@/components/ui/relative-time";
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
import { agentDisplay } from "./agent-activity-presentation";
import { AgentActivityTimeline } from "./agent-activity-timeline";
import { AgentActivityAvatar } from "./agent-activity-avatar";
import { AgentSkills, type AgentSkillsLoadResult } from "./agent-skills";
import { AgentControl } from "./agent-control";
import { AgentReminders } from "./agent-reminders";
import {
  AgentEnvironmentEditor,
  type AgentEnvironmentEditorProps,
} from "./agent-environment-editor";

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
  environment,
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
  environment?: AgentEnvironmentEditorProps;
}) {
  const statusLabel = agentDisplay(detail.display).label;
  const latestError = latestActivityError(activity);
  return (
    <main className="flex h-svh max-h-svh min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background px-4 pt-5 md:px-8 md:pt-8">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-4 pb-6">
        <div className="flex min-w-0 items-center gap-3">
          <MobileNavigationButton />
          <AgentActivityAvatar
            agent={detail}
            size="lg"
            display={detail.display}
            activity={activity}
            timeZone={timeZone}
          />
          <div className="min-w-0">
            <h1 className="break-words text-2xl font-semibold md:text-3xl">{detail.displayName}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              <p className="break-all">@{detail.name}</p>
              <p className="border-l pl-3">{statusLabel}</p>
            </div>
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
      <nav
        className="flex shrink-0 gap-5 overflow-x-auto border-b md:gap-6"
        aria-label={m.agent_detail_tabs()}
      >
        {(["profile", "activity", "reminders"] as const).map((value) => (
          <Link
            key={value}
            to="/agents/$agentId"
            params={{ agentId: detail.id }}
            search={{ tab: value }}
            aria-current={tab === value ? "page" : undefined}
            className={`inline-flex shrink-0 items-center gap-2 border-b-2 px-0.5 pb-3 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${tab === value ? "border-brand text-brand" : "border-transparent text-muted-foreground hover:border-brand hover:text-brand"}`}
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
            environment={environment}
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

function Profile({
  detail,
  timeZone,
  onSaveRuntimeCredential,
  onDeleteRuntimeCredential,
  onUpdate,
  onLoadRuntimeOptions,
  onLoadSkills,
  onExecuteControl,
  environment,
}: {
  detail: Detail;
  timeZone: string | null;
  onSaveRuntimeCredential: (apiKey: string) => Promise<void>;
  onDeleteRuntimeCredential: () => Promise<void>;
  onUpdate: (input: UpdateAgentInput) => Promise<void>;
  onLoadRuntimeOptions: (computerId: string) => Promise<RuntimeOptions>;
  onLoadSkills?: () => Promise<AgentSkillsLoadResult>;
  onExecuteControl?: Parameters<typeof AgentControl>[0]["onExecute"];
  environment?: AgentEnvironmentEditorProps;
}) {
  const [runtimeDialogOpen, setRuntimeDialogOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [runtimeApiKey, setRuntimeApiKey] = useState("");
  const savingRef = useRef(false);
  const [editError, setEditError] = useState("");
  const [runtimeError, setRuntimeError] = useState("");
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
    <div className="divide-y">
      <section className="grid gap-5 py-6 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-8">
        <div className="flex items-start justify-between gap-4">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Bot className="size-4" /> {m.agent_profile_basic()}
          </h2>
          {detail.ownedByCurrentUser && (
            <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
              <Pencil />
              {m.agent_edit()}
            </Button>
          )}
        </div>
        <dl className="grid min-w-0 gap-5">
          {fields.map(({ label, value }) => (
            <div key={label} className="grid gap-1.5 md:grid-cols-[10rem_minmax(0,1fr)] md:gap-6">
              <dt className="text-sm font-medium text-muted-foreground">{label}</dt>
              <dd className="min-w-0 whitespace-pre-wrap break-words text-sm leading-6">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <Dialog
        open={editOpen}
        onOpenChange={(open) => {
          if (savingRef.current) return;
          setEditOpen(open);
          if (open) setEditError("");
        }}
      >
        <DialogPortal keepMounted>
          <DialogBackdrop />
          <DialogPopup>
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
                    apiKey: String(form.get("apiKey") ?? "").trim() || undefined,
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
                <DialogTitle>{m.agent_edit_title()}</DialogTitle>
                <DialogDescription>{m.agent_edit_description()}</DialogDescription>
              </div>
              <div className="grid gap-5 px-6 py-6 text-sm font-medium">
                <label>
                  {m.agent_form_name()}
                  <input
                    name="name"
                    required
                    defaultValue={detail.name}
                    className="mt-1.5 h-10 w-full rounded-lg border bg-background px-3 font-normal shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </label>
                <label>
                  {m.agent_profile_description()}
                  <textarea
                    name="description"
                    rows={4}
                    defaultValue={detail.description}
                    className="mt-1.5 w-full rounded-lg border bg-background p-3 font-normal leading-6 shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </label>
                <label className="sm:col-span-2">
                  {m.agent_form_computer()}
                  <input
                    readOnly
                    value={detail.computer?.label ?? detail.computerId ?? ""}
                    className="mt-1.5 h-10 w-full rounded-lg border bg-muted/50 px-3 font-normal shadow-xs"
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
                  credentialConfigured={
                    Boolean(detail.runtimeCredential) &&
                    (runtime === "pi" || runtime === "coforge") &&
                    Boolean(providerId)
                  }
                  onLoad={onLoadRuntimeOptions}
                />
                {editError && (
                  <p role="alert" className="text-sm text-destructive-text sm:col-span-2">
                    {editError}
                  </p>
                )}
              </div>
              <div className="flex justify-end gap-3 border-t px-6 py-4">
                <Button
                  type="button"
                  variant="outline"
                  disabled={saving}
                  onClick={() => setEditOpen(false)}
                >
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
      <section className="grid gap-5 py-6 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-8">
        <h2 className="flex items-start gap-2 text-base font-semibold">
          <Monitor className="size-4" />
          {m.agent_profile_computer()}
        </h2>
        <div className="min-w-0">
          <p className="break-words text-sm font-medium">
            {detail.computer?.label ?? m.agent_computer_unnamed()}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {detail.computer ? m.agent_computer_observed() : m.agent_computer_not_observed()}
          </p>
        </div>
      </section>
      <section className="grid gap-5 py-6 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-8">
        <div className="flex items-start justify-between gap-4">
          <h2 className="font-semibold">{m.agent_runtime_config()}</h2>
          {canConfigureCredential && (
            <Button size="sm" variant="outline" onClick={() => setRuntimeDialogOpen(true)}>
              <Pencil aria-hidden="true" />
              {m.agent_runtime_edit()}
            </Button>
          )}
        </div>
        <div className="grid min-w-0 gap-5 md:grid-cols-2">
          <RuntimeField
            label={m.agent_runtime_field()}
            value={runtime === "coforge" ? m.agent_provider_pi_builtin() : providerLabel(runtime)}
          />
          {providerKind === "coforge" && (
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
      {detail.ownedByCurrentUser && environment && (
        <AgentEnvironmentEditor key={detail.id} {...environment} />
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
          key={detail.id}
          agentId={detail.id}
          agentName={detail.displayName}
          onExecute={onExecuteControl}
        />
      )}

      <Dialog
        open={runtimeDialogOpen}
        onOpenChange={(open) => {
          if (savingRef.current) return;
          setRuntimeDialogOpen(open);
          if (!open) setRuntimeApiKey("");
          if (open) setRuntimeError("");
        }}
      >
        <DialogPortal keepMounted>
          <DialogBackdrop />
          <DialogPopup>
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
                  setRuntimeApiKey("");
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
                  value={
                    runtime === "coforge" ? m.agent_provider_pi_builtin() : providerLabel(runtime)
                  }
                />
                {runtimeError && (
                  <p role="alert" className="text-sm text-destructive-text sm:col-span-2">
                    {runtimeError}
                  </p>
                )}
                {providerKind === "coforge" && providerId && (
                  <>
                    <RuntimeField label={m.agent_runtime_provider_field()} value={providerId} />
                    <label className="grid gap-1.5 text-sm sm:col-span-2">
                      {m.agent_runtime_api_key({ provider: providerId })}
                      <input
                        name="apiKey"
                        type="password"
                        value={runtimeApiKey}
                        onChange={(event) => setRuntimeApiKey(event.target.value)}
                        required
                        minLength={8}
                        autoComplete="new-password"
                        placeholder={m.agent_runtime_api_key_placeholder({ provider: providerId })}
                        className="h-10 rounded-lg border bg-background px-3 shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                      disabled={saving}
                      onClick={async () => {
                        if (savingRef.current) return;
                        savingRef.current = true;
                        setRuntimeError("");
                        setSaving(true);
                        try {
                          await onDeleteRuntimeCredential();
                          setRuntimeApiKey("");
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
                    variant="outline"
                    disabled={saving}
                    onClick={() => {
                      setRuntimeApiKey("");
                      setRuntimeDialogOpen(false);
                    }}
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

function providerLabel(provider: string) {
  if (provider === "pi") return "Pi";
  if (provider === "codex") return "Codex";
  if (provider === "claude-code") return "Claude Code";
  return provider;
}

function RuntimeField({ label, value }: { label: string; value: string }) {
  return (
    <label className="grid min-w-0 gap-1.5 text-sm font-medium">
      {label}
      <input
        value={value}
        readOnly
        className="h-10 min-w-0 rounded-lg border bg-muted/50 px-3 font-normal text-muted-foreground shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    </label>
  );
}
