import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { Edit01 as Pencil, UserX01, XClose as X } from "@untitledui/icons";

import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import { m } from "@/paraglide/messages";
import { useSubmitGuard } from "@/hooks/use-submit-guard";
import { useLiveAgent, useAgentActivityFeed } from "@/features/agents/workspace-agents-realtime";
import { agentDisplay } from "@/features/agents/agent-activity-presentation";
import { AgentActivityTimeline } from "@/features/agents/agent-activity-timeline";
import { AgentReminders } from "@/features/agents/agent-reminders";
import { listAgentReminders } from "@/features/agents/agent-reminders.functions";
import { getAgentSkills } from "@/features/agents/agent-skills.functions";
import {
  listAgentWorkspaceFiles,
  readAgentWorkspaceFile,
} from "@/features/agents/agent-workspace-files.functions";
import { useAgentRuntimeControls } from "@/features/agents/agent-runtime-controls";
import { runtimeProviderLabel } from "@/features/agents/runtime-provider-display";
import { executeAgentControl } from "@/features/agents/agent-control.functions";
import { AgentControlDialogs } from "@/features/agents/agent-control-dialogs";
import { AgentRuntimeCredentialDialog } from "@/features/agents/agent-runtime-credential-dialog";
import {
  AgentRuntimeConfigDialog,
  type AgentEnvironmentState,
} from "@/features/agents/agent-runtime-config-dialog";
import { useAgentRuntimeOptionsLoader } from "@/features/agents/agent-runtime-options";
import {
  agentUpdateErrorMessage,
  parseAgentEnvironmentFromForm,
  updateAgentInputFromForm,
} from "@/features/agents/agent-form";
import {
  updateAgent,
  updateAgentRole,
  saveAgentRuntimeCredential,
  deleteAgentRuntimeCredential,
  saveAgentEnvironment,
  deleteAgent,
} from "@/features/agents/agents.functions";
import { AgentDeleteDialog } from "@/features/agents/agent-delete-dialog";
import { AgentProfileHeader } from "./agent-profile-header";
import { AgentProfileTabs } from "./agent-profile-tabs";
import { AgentProfileTab } from "./agent-profile-tab";
import { AgentWorkspaceTab } from "./agent-workspace-tab";
import {
  resolveAgentProfileTab,
  type AgentProfileTab as ProfileTabId,
} from "./profile-panel-search";
import {
  agentEnvironmentKey,
  agentEnvironmentQuery,
  useAgentProfileData,
  useInvalidateAgentProfile,
} from "./agent-profile-queries";

const appRoute = getRouteApi("/_app");

/**
 * The conversation's right-hand slot content when the Agent profile is the visible panel: same
 * chrome as the Thread panel (48px header band, 44px tab band, flat body, no page-level card),
 * built from `getAgentProfile` plus the existing workspace realtime hooks for live status/activity
 * — never its own subscription (`apps/web/AGENTS.md`'s panel-ownership rule).
 */
export function AgentProfilePanel({
  agentId,
  requestedTab,
  onTabChange,
  onClose,
}: {
  agentId: string;
  requestedTab: ProfileTabId | undefined;
  onTabChange: (tab: ProfileTabId) => void;
  onClose: () => void;
}) {
  const timeZone = appRoute.useLoaderData().timeZone;
  // Escape closes the panel, like Thread's Close; an open overlay or a field being edited keeps it.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("input, textarea, [contenteditable=true]")) return;
      if (document.querySelector("[role=dialog], [role=alertdialog], [role=listbox], [role=menu]"))
        return;
      onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  const liveAgent = useLiveAgent(agentId);
  const query = useAgentProfileData(agentId);
  const profile = query.data;
  const invalidate = useInvalidateAgentProfile(agentId);
  const liveActivity = useAgentActivityFeed(agentId);
  const activity = liveActivity ?? profile?.activity ?? [];

  const knownName = profile?.displayName ?? liveAgent?.displayName ?? "";
  const canManage = profile ? profile.canManageAgentRole || profile.ownedByCurrentUser : false;
  const canSeeWorkspace = profile ? profile.ownedByCurrentUser : false;
  const tab = resolveAgentProfileTab(requestedTab, canManage, canSeeWorkspace);

  const loadReminders = useServerFn(listAgentReminders);
  const onLoadReminders = useCallback(
    (cursor?: { id: string }) =>
      loadReminders({ data: { agentId, ...(cursor ? { cursor } : {}) } }),
    [agentId, loadReminders],
  );

  const loadSkills = useServerFn(getAgentSkills);
  const onLoadSkills = useCallback(() => loadSkills({ data: agentId }), [agentId, loadSkills]);

  const listWorkspaceFiles = useServerFn(listAgentWorkspaceFiles);
  const onListWorkspaceDir = useCallback(
    (dirPath: string, includeHidden: boolean) =>
      listWorkspaceFiles({ data: { agentId, dirPath, includeHidden } }),
    [agentId, listWorkspaceFiles],
  );
  const readWorkspaceFile = useServerFn(readAgentWorkspaceFile);
  const onReadWorkspaceFile = useCallback(
    (path: string) => readWorkspaceFile({ data: { agentId, path } }),
    [agentId, readWorkspaceFile],
  );

  // Shared by the RUNTIME CONFIG section's masked chips (`agent-profile-tab.tsx`) and the
  // Runtime config dialog's Advanced disclosure — one owner-only load, not two.
  const queryClient = useQueryClient();
  const envQuery = useQuery(agentEnvironmentQuery(agentId, Boolean(profile?.ownedByCurrentUser)));
  const saveEnvironment = useServerFn(saveAgentEnvironment);
  const environmentState: AgentEnvironmentState | undefined = profile?.ownedByCurrentUser
    ? { loaded: envQuery.isSuccess, values: envQuery.data ?? {} }
    : undefined;

  const executeControl = useServerFn(executeAgentControl);
  const controls = useAgentRuntimeControls({
    agentId,
    agentName: knownName || agentId,
    canFullReset: profile?.canFullResetAgent ?? false,
    isOnline: agentDisplay(liveAgent?.display, { stopped: profile?.stopped }).isOnline,
    computerOnline: profile?.computer?.online,
    computerLabel: profile?.computer?.label,
    onExecute: async (request) => {
      await executeControl({ data: request });
      await invalidate();
    },
  });

  const update = useServerFn(updateAgent);
  const updateRole = useServerFn(updateAgentRole);
  const saveCredential = useServerFn(saveAgentRuntimeCredential);
  const deleteCredential = useServerFn(deleteAgentRuntimeCredential);
  const removeAgent = useServerFn(deleteAgent);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [runtimeDialogOpen, setRuntimeDialogOpen] = useState(false);
  const [runtimeSaving, guardRuntime] = useSubmitGuard();
  const [runtimeError, setRuntimeError] = useState("");
  const onLoadRuntimeOptions = useAgentRuntimeOptionsLoader();
  const [runtimeEditing, setRuntimeEditing] = useState(false);
  const [runtimeFormSaving, guardRuntimeForm] = useSubmitGuard();
  const [runtimeFormError, setRuntimeFormError] = useState("");

  function baseUpdateInput(overrides: { displayName?: string; description?: string }) {
    if (!profile) throw new Error("profile not loaded");
    return {
      agentId: profile.id,
      displayName: overrides.displayName ?? profile.displayName,
      description: overrides.description ?? profile.description ?? "",
      provider: profile.runtimeConfig.runtime,
      modelProvider: profile.runtimeConfig.modelProvider || undefined,
      model: profile.runtimeConfig.model,
      reasoning: profile.runtimeConfig.reasoning,
      ...(profile.computerId ? { computerId: profile.computerId } : {}),
    };
  }

  function onStartRuntimeEdit() {
    setRuntimeFormError("");
    setRuntimeEditing(true);
  }
  function onCancelRuntimeEdit() {
    setRuntimeEditing(false);
    setRuntimeFormError("");
  }
  // Reuses the full page's edit-dialog submit path (`updateAgentInputFromForm` +
  // `agentUpdateErrorMessage`, `agent-form.ts`) so the two Runtime config editors never drift.
  // The panel's form carries only the runtime fields, so displayName/description are supplied
  // as fallbacks — never blanked by this save. Env rows are a second, independent save
  // (`saveAgentEnvironment`) gated by the form's own `changed.environment` flag, since Save can
  // fire with only one of the two actually different from what loaded.
  function onSaveRuntime(form: FormData, changed: { runtime: boolean; environment: boolean }) {
    void guardRuntimeForm(async () => {
      if (!profile || !profile.computer) return;
      setRuntimeFormError("");
      try {
        if (changed.runtime)
          await update({
            data: updateAgentInputFromForm(form, {
              agentId: profile.id,
              computerId: profile.computer.id,
              displayName: profile.displayName,
              description: profile.description ?? "",
            }),
          });
        if (changed.environment && profile.ownedByCurrentUser)
          await saveEnvironment({
            data: { agentId: profile.id, envVars: parseAgentEnvironmentFromForm(form) },
          });
        setRuntimeEditing(false);
        await Promise.all([
          invalidate(),
          queryClient.invalidateQueries({ queryKey: agentEnvironmentKey(profile.id) }),
        ]);
      } catch (cause) {
        setRuntimeFormError(agentUpdateErrorMessage(cause));
      }
    });
  }

  if (query.isError)
    return (
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex h-12 shrink-0 items-center justify-end border-b border-secondary pr-2">
          <ButtonUtility
            icon={X}
            size="sm"
            color="tertiary"
            tooltip={m.controls_close()}
            onClick={onClose}
          />
        </header>
        <Empty className="flex-1 items-center justify-center px-6 text-center">
          <EmptyHeader className="items-center gap-3">
            <EmptyMedia>
              <UserX01 aria-hidden="true" className="size-6 text-tertiary" />
            </EmptyMedia>
            <EmptyTitle role="heading" aria-level={2}>
              {m.agent_profile_not_found_title()}
            </EmptyTitle>
            <EmptyDescription>{m.agent_profile_not_found_description()}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <AgentProfileHeader
        agent={{
          id: agentId,
          name: profile?.name ?? liveAgent?.name ?? "",
          displayName: knownName,
          description: profile?.description ?? undefined,
        }}
        display={liveAgent?.display}
        timeZone={timeZone}
        controls={controls}
        onClose={onClose}
      />
      {/* The four tabs need ~465px, more than a phone is wide, so the band scrolls instead of
          pushing the panel (and with it the whole page) past the viewport. */}
      <div className="scrollbar-hide flex h-11 shrink-0 items-center overflow-x-auto border-b border-secondary px-5">
        <AgentProfileTabs
          active={tab}
          showManagerTabs={canManage}
          showWorkspaceTab={canSeeWorkspace}
          onSelect={onTabChange}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!profile ? (
          <div className="flex flex-col gap-4 px-5 py-5">
            <div className="flex items-center gap-4">
              <Skeleton className="size-16 shrink-0 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-4 w-20" />
              </div>
            </div>
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : tab === "activity" ? (
          <AgentActivityTimeline activity={activity} timeZone={timeZone} compact />
        ) : tab === "reminders" ? (
          <div className="px-5 pb-5">
            <AgentReminders
              agentId={agentId}
              owned={profile.ownedByCurrentUser}
              timeZone={timeZone}
              onLoad={onLoadReminders}
            />
          </div>
        ) : tab === "workspace" ? (
          <AgentWorkspaceTab
            agentId={agentId}
            onListDir={onListWorkspaceDir}
            onReadFile={onReadWorkspaceFile}
          />
        ) : (
          <AgentProfileTab
            profile={profile}
            timeZone={timeZone}
            canManage={canManage}
            controls={controls}
            // Realtime once a display snapshot has arrived, the initial `getAgentProfile` load
            // until then — trusting `liveAgent.display`'s own (possibly explicitly null)
            // `contextUsage` once present, never falling back past it to a stale initial read.
            // Display-only (ADR 0050): nothing here triggers on any threshold.
            contextUsage={
              liveAgent?.display
                ? (liveAgent.display.contextUsage ?? null)
                : (profile.display?.contextUsage ?? null)
            }
            onSaveDisplayName={async (value) => {
              await update({ data: baseUpdateInput({ displayName: value }) });
              await invalidate();
            }}
            onSaveDescription={async (value) => {
              await update({ data: baseUpdateInput({ description: value }) });
              await invalidate();
            }}
            onSaveRole={
              profile.canManageAgentRole
                ? async (role) => {
                    await updateRole({ data: { agentId, role } });
                    await invalidate();
                  }
                : undefined
            }
            onStartRuntimeEdit={onStartRuntimeEdit}
            onLoadSkills={profile.ownedByCurrentUser ? onLoadSkills : undefined}
            envVars={profile.ownedByCurrentUser ? (envQuery.data ?? {}) : undefined}
            onStartDelete={profile.canDeleteAgent ? () => setDeleteDialogOpen(true) : undefined}
            runtimeCredentialDialog={
              profile.ownedByCurrentUser && profile.runtimeConfig.provider.kind === "coforge" ? (
                <>
                  <ButtonUtility
                    aria-label={m.agent_runtime_edit()}
                    tooltip={m.agent_runtime_edit()}
                    icon={Pencil}
                    size="xs"
                    color="tertiary"
                    onClick={() => {
                      setRuntimeError("");
                      setRuntimeDialogOpen(true);
                    }}
                  />
                  {runtimeDialogOpen && (
                    <AgentRuntimeCredentialDialog
                      open={runtimeDialogOpen}
                      onOpenChange={setRuntimeDialogOpen}
                      saving={runtimeSaving}
                      runtimeLabel={runtimeProviderLabel(profile.runtimeConfig.runtime)}
                      providerId={
                        profile.runtimeConfig.provider.kind === "coforge"
                          ? profile.runtimeConfig.provider.providerId
                          : ""
                      }
                      credentialHint={profile.runtimeCredential?.hint}
                      error={runtimeError}
                      modelFields={[
                        {
                          label: m.agent_form_model(),
                          value: profile.runtimeConfig.model || m.agent_form_provider_default(),
                        },
                        {
                          label: m.agent_form_reasoning(),
                          value: profile.runtimeConfig.reasoning || m.agent_form_provider_default(),
                        },
                      ]}
                      onSave={(apiKey) =>
                        guardRuntime(async () => {
                          setRuntimeError("");
                          try {
                            await saveCredential({ data: { agentId, apiKey } });
                            setRuntimeDialogOpen(false);
                            await invalidate();
                          } catch {
                            setRuntimeError(m.agent_runtime_save_error());
                          }
                        })
                      }
                      onDelete={
                        profile.runtimeCredential
                          ? () =>
                              guardRuntime(async () => {
                                setRuntimeError("");
                                try {
                                  await deleteCredential({ data: agentId });
                                  setRuntimeDialogOpen(false);
                                  await invalidate();
                                } catch {
                                  setRuntimeError(m.agent_runtime_delete_error());
                                }
                              })
                          : undefined
                      }
                    />
                  )}
                </>
              ) : null
            }
          />
        )}
      </div>
      {profile && profile.computer && (
        <AgentRuntimeConfigDialog
          open={runtimeEditing}
          onClose={onCancelRuntimeEdit}
          computerId={profile.computer.id}
          credentialConfigured={Boolean(profile.runtimeCredential)}
          initial={{
            provider: profile.runtimeConfig.runtime,
            modelProvider: profile.runtimeConfig.modelProvider,
            model: profile.runtimeConfig.model,
            reasoning: profile.runtimeConfig.reasoning,
          }}
          onLoad={onLoadRuntimeOptions}
          environment={environmentState}
          saving={runtimeFormSaving}
          error={runtimeFormError}
          onSave={onSaveRuntime}
        />
      )}
      <AgentControlDialogs agentName={knownName} control={controls} />
      {profile && (
        <AgentDeleteDialog
          agentName={profile.name}
          open={deleteDialogOpen}
          onOpenChange={setDeleteDialogOpen}
          onDelete={async (confirmation) => {
            // A protected Agent throws server-side (the dialog shows its own message), so reaching
            // here means the Agent really was deleted.
            await removeAgent({ data: { agentId, confirmation } });
            setDeleteDialogOpen(false);
            // The Agent is gone from every live view, so the panel has nothing left to show.
            onClose();
            await invalidate();
          }}
        />
      )}
    </div>
  );
}
