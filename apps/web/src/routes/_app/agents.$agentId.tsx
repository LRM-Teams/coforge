import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useMemo } from "react";

import { AgentDetail } from "@/features/agents/agent-detail";
import { listAgentReminders } from "@/features/agents/agent-reminders.functions";
import { AgentDetailPending } from "@/features/agents/agent-detail-pending";
import { getAgentSkills } from "@/features/agents/agent-skills.functions";
import { executeAgentControl } from "@/features/agents/agent-control.functions";
import {
  deleteAgentRuntimeCredential,
  getAgentDetail,
  saveAgentRuntimeCredential,
  updateAgent,
  getAgentEnvironment,
  saveAgentEnvironment,
} from "@/features/agents/agents.functions";
import { getUserPreferences } from "@/features/settings/settings.functions";
import { PageLoadError } from "@/features/errors/page-load-error";
import { getComputerRuntimeCatalog, listComputers } from "@/features/computers/computers.functions";
import { useAgentActivityFeed, useLiveAgent } from "@/features/agents/workspace-agents-realtime";
import { agentActivityFeedQuery } from "@/features/agents/agent-activity-queries";
import { mergeAgentActivity } from "@/features/agents/agent-activity";

function detailTab(value: unknown): "profile" | "activity" | "reminders" {
  if (value === "activity") return "activity";
  if (value === "reminders") return "reminders";
  return "profile";
}

export const Route = createFileRoute("/_app/agents/$agentId")({
  validateSearch: (search) => ({
    tab: detailTab(search.tab),
    edit: search.edit === true,
  }),
  loader: async ({ context, params }) => {
    const [detail, preferences, computers] = await Promise.all([
      getAgentDetail({ data: params.agentId }),
      getUserPreferences(),
      listComputers(),
    ]);
    // Seed the Activity tab's feed in the Query cache; the shared Activity
    // subscription patches this entry from here on.
    context.queryClient.setQueryData(agentActivityFeedQuery(params.agentId).queryKey, (current) =>
      mergeAgentActivity(current ?? [], detail.activity),
    );
    return { detail, timeZone: preferences.timeZone, computers };
  },
  pendingMs: 300,
  pendingMinMs: 0,
  pendingComponent: AgentDetailPendingPage,
  errorComponent: PageLoadError,
  component: AgentDetailPage,
});

function AgentDetailPendingPage() {
  return <AgentDetailPending tab={Route.useSearch().tab} />;
}

function AgentDetailPage() {
  const { detail, timeZone, computers } = Route.useLoaderData();
  const { edit } = Route.useSearch();
  const router = useRouter();
  const saveCredential = useServerFn(saveAgentRuntimeCredential);
  const deleteCredential = useServerFn(deleteAgentRuntimeCredential);
  const loadEnvironment = useServerFn(getAgentEnvironment);
  const saveEnvironment = useServerFn(saveAgentEnvironment);
  const update = useServerFn(updateAgent);
  const loadComputers = useServerFn(listComputers);
  const loadCatalog = useServerFn(getComputerRuntimeCatalog);
  const loadSkills = useServerFn(getAgentSkills);
  const executeControl = useServerFn(executeAgentControl);
  const loadReminders = useServerFn(listAgentReminders);
  const liveAgent = useLiveAgent(detail.id);
  const activity = useAgentActivityFeed(detail.id) ?? detail.activity;
  const loadAgentSkills = useCallback(
    () => loadSkills({ data: detail.id }),
    [loadSkills, detail.id],
  );
  const loadAgentReminders = useCallback(
    (cursor?: { id: string }) =>
      loadReminders({ data: { agentId: detail.id, ...(cursor ? { cursor } : {}) } }),
    [detail.id, loadReminders],
  );
  // Profile is memoized; keep everything it receives referentially stable so a
  // status heartbeat only re-renders the header.
  const environment = useMemo(
    () => ({
      onLoad: () => loadEnvironment({ data: detail.id }),
      onSave: async (envVars: Parameters<typeof saveEnvironment>[0]["data"]["envVars"]) => {
        const result = await saveEnvironment({ data: { agentId: detail.id, envVars } });
        await router.invalidate({ sync: true });
        return result;
      },
    }),
    [detail.id, loadEnvironment, saveEnvironment, router],
  );
  const onExecuteControl = useCallback(
    (request: Parameters<typeof executeControl>[0]["data"]) => executeControl({ data: request }),
    [executeControl],
  );
  const onLoadRuntimeOptions = useCallback(
    async (computerId: string) => {
      const [computers, catalogs] = await Promise.all([
        loadComputers(),
        loadCatalog({ data: { computerId } }),
      ]);
      return {
        providers:
          computers
            .find((computer) => computer.id === computerId)
            ?.runtimes.map((runtime) => runtime.provider) ?? [],
        catalogs,
      };
    },
    [loadComputers, loadCatalog],
  );
  const onSaveRuntimeCredential = useCallback(
    async (apiKey: string) => {
      await saveCredential({ data: { agentId: detail.id, apiKey } });
      await router.invalidate({ sync: true });
    },
    [saveCredential, detail.id, router],
  );
  const onDeleteRuntimeCredential = useCallback(async () => {
    await deleteCredential({ data: detail.id });
    await router.invalidate({ sync: true });
  }, [deleteCredential, detail.id, router]);
  const onUpdate = useCallback(
    async (input: Parameters<typeof update>[0]["data"]) => {
      await update({ data: input });
      await router.invalidate({ sync: true });
    },
    [update, router],
  );
  return (
    <AgentDetail
      activity={activity}
      detail={detail}
      display={liveAgent?.display ?? detail.display}
      timeZone={timeZone}
      tab={Route.useSearch().tab}
      initialEditOpen={edit}
      environment={environment}
      onLoadSkills={loadAgentSkills}
      onExecuteControl={onExecuteControl}
      onLoadReminders={loadAgentReminders}
      onLoadRuntimeOptions={onLoadRuntimeOptions}
      onSaveRuntimeCredential={onSaveRuntimeCredential}
      onDeleteRuntimeCredential={onDeleteRuntimeCredential}
      onUpdate={onUpdate}
      availableComputers={computers.map((computer) => ({
        id: computer.id,
        displayName: computer.displayName,
        online: computer.online,
      }))}
    />
  );
}
