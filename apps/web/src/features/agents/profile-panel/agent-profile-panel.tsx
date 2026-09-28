import { useCallback, useEffect, useEffectEvent, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useRouter } from "@tanstack/react-router";
import { ArrowLeft, Edit01 as Pencil, UserX01, XClose as X } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { isAppError } from "#src/lib/app-error";
import { Skeleton } from "#src/components/ui/skeleton";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "#src/components/ui/empty";
import { m } from "#src/paraglide/messages";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import {
  useAgentActivityFeed,
  useLiveAgent,
  usePrefetchAgentActivityFeed,
} from "#src/features/agents/workspace-agents-realtime";
import { agentDisplay } from "#src/features/agents/agent-activity-presentation";
import { AgentActivityTimeline } from "#src/features/agents/agent-activity-timeline";
import { AgentReminders } from "#src/features/agents/agent-reminders";
import { listAgentReminders } from "#src/features/agents/agent-reminders.functions";
import { getAgentSkills } from "#src/features/agents/agent-skills.functions";
import {
  listAgentWorkspaceFiles,
  readAgentWorkspaceFile,
} from "#src/features/agents/agent-workspace-files.functions";
import { useAgentRuntimeControls } from "#src/features/agents/agent-runtime-controls";
import { runtimeProviderLabel } from "#src/features/agents/runtime-provider-display";
import { executeAgentControl } from "#src/features/agents/agent-control.functions";
import { AgentControlDialogs } from "#src/features/agents/agent-control-dialogs";
import { AgentRuntimeCredentialDialog } from "#src/features/agents/agent-runtime-credential-dialog";
import {
  AgentRuntimeConfigDialog,
  type AgentEnvironmentState,
} from "#src/features/agents/agent-runtime-config-dialog";
import { useAgentRuntimeOptionsLoader } from "#src/features/agents/agent-runtime-options";
import { listComputers } from "#src/features/computers/computers.functions";
import {
  agentUpdateErrorMessage,
  parseAgentEnvironmentFromForm,
  updateAgentInputFromForm,
} from "#src/features/agents/agent-form";
import {
  updateAgent,
  uploadAgentAvatar,
  removeAgentAvatar,
  updateAgentRole,
  saveAgentRuntimeCredential,
  deleteAgentRuntimeCredential,
  saveAgentEnvironment,
  deleteAgent,
  changeAgentVisibility,
  previewAgentVisibilityChange,
} from "#src/features/agents/agents.functions";
import { AgentDeleteDialog } from "#src/features/agents/agent-delete-dialog";
import { AgentVisibilityConfirmDialog } from "#src/features/agents/agent-visibility-confirm-dialog";
import type { AgentVisibility } from "#src/features/agents/agent-visibility";
import { useAppToast } from "#src/components/ui/toast";
import { AgentProfileHeader } from "./agent-profile-header";
import { AgentProfileTabs, useAgentProfileTabOrder } from "./agent-profile-tabs";
import { AgentProfileTab } from "./agent-profile-tab";
import { AgentWorkspaceTab } from "./agent-workspace-tab";
import { PanelMessage } from "./panel-message";
import {
  resolveAgentProfileTab,
  type AgentProfileTab as ProfileTabId,
} from "./profile-panel-search";
import {
  agentEnvironmentKey,
  agentEnvironmentQuery,
  agentProfileQuery,
  useInvalidateAgentProfile,
} from "./agent-profile-queries";

const appRoute = getRouteApi("/_app");

/**
 * An Agent's profile: the conversation's right-hand slot content when it is the visible panel,
 * and a page of the channel settings sheet (with `back`) opened from its members. Same
 * chrome as the Thread panel (48px header band, 44px tab band, flat body, no page-level card),
 * built from `getAgentProfile` plus the existing workspace realtime hooks for live status/activity
 * — never its own subscription (`src/features/agents/AGENTS.md`'s Agent-state rule).
 */
export function AgentProfilePanel({
  agentId,
  requestedTab,
  onTabChange,
  onClose,
  back,
}: {
  agentId: string;
  requestedTab: ProfileTabId | undefined;
  onTabChange: (tab: ProfileTabId) => void;
  onClose: () => void;
  /** Shown inside another page: its Back button (see `AgentProfileHeader`). */
  back?: { label: string; onPress: () => void };
}) {
  const timeZone = appRoute.useLoaderData().timeZone;
  const router = useRouter();
  // Escape closes the panel, like Thread's Close; an open overlay or a field being edited keeps it.
  // An effect event, so a caller's fresh `onClose` each render does not re-add the listener.
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest("input, textarea, [contenteditable=true]")) return;
    if (document.querySelector("[role=dialog], [role=alertdialog], [role=listbox], [role=menu]"))
      return;
    onClose();
  });
  useEffect(() => {
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
  const liveAgent = useLiveAgent(agentId);
  const query = useQuery(agentProfileQuery(agentId));
  const profile = query.data;
  const invalidate = useInvalidateAgentProfile(agentId);
  usePrefetchAgentActivityFeed(agentId);

  const knownName = profile?.displayName ?? liveAgent?.displayName ?? "";
  const canManage = profile ? profile.canManageAgentRole || profile.ownedByCurrentUser : false;
  const canSeeWorkspace = profile ? profile.ownedByCurrentUser : false;
  const loadComputers = useServerFn(listComputers);
  const computersQuery = useQuery({
    queryKey: ["agent-runtime-computers", profile?.id, profile?.computerId ?? "none"],
    queryFn: () => loadComputers(),
    enabled: Boolean(profile && canManage && !profile.computer),
  });
  const setupComputers =
    profile && !profile.computer && computersQuery.isSuccess
      ? (computersQuery.data ?? []).map((computer) => ({
          id: computer.id,
          displayName: computer.displayName || computer.name || m.agent_computer_unnamed(),
          online: Boolean(computer.online),
        }))
      : undefined;
  const tabOrder = useAgentProfileTabOrder(canManage, canSeeWorkspace);
  const tab = resolveAgentProfileTab(requestedTab, tabOrder.tabs);
  // Opened without `agentTab`, the panel lands on the first tab of the viewer's order once their
  // permissions are known, and records it through `onTabChange` (the URL, or the embedding page's
  // state) so a later reorder does not move it.
  const loaded = Boolean(profile);
  useEffect(() => {
    if (loaded && !requestedTab) onTabChange(tab);
  }, [loaded, requestedTab, tab, onTabChange]);

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
  const uploadAvatar = useServerFn(uploadAgentAvatar);
  const removeAvatar = useServerFn(removeAgentAvatar);
  const updateRole = useServerFn(updateAgentRole);
  const saveCredential = useServerFn(saveAgentRuntimeCredential);
  const deleteCredential = useServerFn(deleteAgentRuntimeCredential);
  const removeAgent = useServerFn(deleteAgent);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const changeVisibility = useServerFn(changeAgentVisibility);
  const loadVisibilityPreview = useServerFn(previewAgentVisibilityChange);
  const [visibilityTarget, setVisibilityTarget] = useState<AgentVisibility | null>(null);
  const toast = useAppToast();
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
      if (!profile) return;
      setRuntimeFormError("");
      try {
        if (changed.runtime)
          await update({
            data: updateAgentInputFromForm(form, {
              agentId: profile.id,
              computerId: profile.computer?.id,
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
          queryClient.invalidateQueries({
            queryKey: ["agent-runtime-computers", profile.id, profile.computerId ?? "none"],
          }),
        ]);
      } catch (cause) {
        setRuntimeFormError(agentUpdateErrorMessage(cause));
      }
    });
  }

  if (query.isError) {
    // An Agent that exists but is private to someone else answers a distinct, detail-
    // free state — no "you may not have access, or it was removed" guess, just the one fact.
    const notVisible = isAppError(query.error) && query.error.code === "AGENT_NOT_VISIBLE";
    return (
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-secondary px-2">
          {back ? (
            <ButtonUtility
              icon={ArrowLeft}
              size="sm"
              color="tertiary"
              tooltip={back.label}
              aria-label={back.label}
              onClick={back.onPress}
            />
          ) : (
            <span />
          )}
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
              {notVisible ? m.agent_not_visible() : m.agent_profile_not_found_title()}
            </EmptyTitle>
            {!notVisible && (
              <EmptyDescription>{m.agent_profile_not_found_description()}</EmptyDescription>
            )}
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <AgentProfileHeader
        agent={{
          id: agentId,
          name: profile?.name ?? liveAgent?.name ?? "",
          displayName: knownName,
          description: profile?.description ?? undefined,
          avatarUrl: profile?.avatarUrl,
        }}
        // `liveAgent` (the shared realtime roster) is blank for an Agent outside the
        // viewer's own `listAgents` roster until its first live publication arrives — e.g. an
        // owner/admin's placeholder for another member's private Agent. `getAgentProfile`
        // (`profile`, this panel's own authorized fetch) already computes an initial
        // status/display snapshot for any Agent the viewer can see; prefer the live one once a
        // publication lands, but seed from the authorized fetch instead of showing nothing.
        display={liveAgent?.display ?? profile?.display}
        timeZone={timeZone}
        controls={controls}
        onClose={onClose}
        back={back}
      />
      {/* The four tabs need ~465px, more than a phone is wide, so the band scrolls instead of
          pushing the panel (and with it the whole page) past the viewport. */}
      <div className="scrollbar-hide flex h-14 shrink-0 items-center overflow-x-auto border-b border-secondary px-5">
        <AgentProfileTabs
          active={tab}
          tabs={tabOrder.tabs}
          onSelect={onTabChange}
          onReorder={tabOrder.reorder}
        />
      </div>
      {/* Workspace is a split tree/file viewer: each pane scrolls on its own. A shared
          overflow here would grow with the file and drag the tree out of view. */}
      <div
        className={
          profile && tab === "workspace"
            ? "flex min-h-0 flex-1 flex-col overflow-hidden"
            : "min-h-0 flex-1 overflow-y-auto"
        }
      >
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
          <AgentActivityTab agentId={agentId} timeZone={timeZone} />
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
            // Display-only: nothing here triggers on any threshold.
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
            onAvatarChange={
              profile.ownedByCurrentUser
                ? async (file) => {
                    const data = new FormData();
                    data.set("agentId", agentId);
                    data.set("file", file);
                    await uploadAvatar({ data });
                    await invalidate();
                    await router.invalidate();
                  }
                : undefined
            }
            onAvatarRemove={
              profile.ownedByCurrentUser
                ? async () => {
                    await removeAvatar({ data: { agentId } });
                    await invalidate();
                    await router.invalidate();
                  }
                : undefined
            }
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
            onRequestVisibilityChange={
              profile.canChangeVisibility ? (target) => setVisibilityTarget(target) : undefined
            }
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
      {profile && (
        <AgentRuntimeConfigDialog
          open={runtimeEditing}
          onClose={onCancelRuntimeEdit}
          computerId={profile.computer?.id ?? ""}
          computers={setupComputers}
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
      {profile && visibilityTarget && (
        <AgentVisibilityConfirmDialog
          agentName={profile.displayName || profile.name}
          creatorName={profile.owner.displayName?.trim() || profile.owner.username}
          viewerIsCreator={profile.ownedByCurrentUser}
          target={visibilityTarget}
          open={visibilityTarget !== null}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setVisibilityTarget(null);
          }}
          onLoadPreview={() => loadVisibilityPreview({ data: agentId })}
          onConfirm={async () => {
            await changeVisibility({ data: { agentId, visibility: visibilityTarget } });
            setVisibilityTarget(null);
            await invalidate();
            const displayName = profile.displayName || profile.name;
            toast.success(
              visibilityTarget === "private"
                ? m.agent_visibility_changed_private_toast({ name: displayName })
                : m.agent_visibility_changed_public_toast({ name: displayName }),
            );
          }}
        />
      )}
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

function AgentActivityTab({ agentId, timeZone }: { agentId: string; timeZone: string | null }) {
  const feed = useAgentActivityFeed(agentId);
  if (feed.data) return <AgentActivityTimeline activity={feed.data} timeZone={timeZone} compact />;
  if (feed.isError && !feed.isFetching)
    return (
      <PanelMessage text={m.agent_activity_error()} alert onRetry={() => void feed.refetch()} />
    );
  return (
    <div aria-busy="true" className="flex flex-col gap-5 px-4 py-4">
      <p role="status" className="sr-only">
        {m.agent_activity_loading()}
      </p>
      {["w-2/5", "w-3/5", "w-1/2", "w-3/4"].map((width) => (
        <div key={width} className="grid grid-cols-[3.5rem_1fr] gap-2">
          <Skeleton className="h-4 w-12" />
          <Skeleton className={`h-4 ${width}`} />
        </div>
      ))}
    </div>
  );
}
