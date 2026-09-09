import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useMemo } from "react";

import { AgentDetail } from "@/features/agents/agent-detail";
import {
  getAgentReminderHistory,
  listAgentReminders,
} from "@/features/agents/agent-reminders.functions";
import { getAgentSkills } from "@/features/agents/agent-skills.functions";
import { executeAgentControl } from "@/features/agents/agent-control.functions";
import { useAgentStatuses } from "@/features/agents/agent-status-realtime";
import { useAgentActivity } from "@/features/agents/agent-activity-realtime";
import {
  deleteAgentRuntimeCredential,
  getAgentDetail,
  getAgentActivityConnectionToken,
  saveAgentRuntimeCredential,
  updateAgent,
} from "@/features/agents/agents.functions";
import { m } from "@/paraglide/messages";
import { getUserPreferences } from "@/features/settings/settings.functions";
import { PageLoadError } from "@/features/errors/page-load-error";
import { getComputerRuntimeCatalog, listComputers } from "@/features/computers/computers.functions";

function detailTab(value: unknown): "profile" | "activity" | "reminders" {
  if (value === "activity") return "activity";
  if (value === "reminders") return "reminders";
  return "profile";
}

export const Route = createFileRoute("/_app/agents/$agentId")({
  validateSearch: (search) => ({ tab: detailTab(search.tab) }),
  loader: async ({ params }) => {
    const [detail, preferences] = await Promise.all([
      getAgentDetail({ data: params.agentId }),
      getUserPreferences(),
    ]);
    return { detail, timeZone: preferences.timeZone };
  },
  pendingComponent: () => (
    <main className="flex-1 p-6 text-sm text-muted-foreground">{m.agent_detail_loading()}</main>
  ),
  errorComponent: PageLoadError,
  component: AgentDetailPage,
});

function AgentDetailPage() {
  const { detail, timeZone } = Route.useLoaderData();
  const router = useRouter();
  const saveCredential = useServerFn(saveAgentRuntimeCredential);
  const deleteCredential = useServerFn(deleteAgentRuntimeCredential);
  const update = useServerFn(updateAgent);
  const loadComputers = useServerFn(listComputers);
  const loadCatalog = useServerFn(getComputerRuntimeCatalog);
  const loadDetail = useServerFn(getAgentDetail);
  const loadSkills = useServerFn(getAgentSkills);
  const executeControl = useServerFn(executeAgentControl);
  const loadReminders = useServerFn(listAgentReminders);
  const loadReminderHistory = useServerFn(getAgentReminderHistory);
  const agents = useMemo(() => [detail], [detail]);
  const refresh = useCallback(
    async () => [await loadDetail({ data: detail.id })],
    [loadDetail, detail.id],
  );
  const visibleAgents = useAgentStatuses({
    agents,
    workspaceId: detail.workspaceId,
    refresh,
  });
  const getActivityToken = useServerFn(getAgentActivityConnectionToken);
  const refreshActivity = useCallback(
    async () => (await loadDetail({ data: detail.id })).activity,
    [loadDetail, detail.id],
  );
  const activity = useAgentActivity({
    agentId: detail.id,
    workspaceId: detail.workspaceId,
    activity: detail.activity,
    refresh: refreshActivity,
    getConnectionToken: getActivityToken,
  });
  const loadAgentSkills = useCallback(
    () => loadSkills({ data: detail.id }),
    [loadSkills, detail.id],
  );
  const loadAgentReminders = useCallback(
    (cursor?: { id: string }) =>
      loadReminders({ data: { agentId: detail.id, ...(cursor ? { cursor } : {}) } }),
    [detail.id, loadReminders],
  );
  const loadAgentReminderHistory = useCallback(
    (reminderId: string) => loadReminderHistory({ data: { agentId: detail.id, reminderId } }),
    [detail.id, loadReminderHistory],
  );
  return (
    <AgentDetail
      activity={activity}
      detail={visibleAgents.find((agent) => agent.id === detail.id) ?? detail}
      timeZone={timeZone}
      tab={Route.useSearch().tab}
      onLoadSkills={loadAgentSkills}
      onExecuteControl={(request) => executeControl({ data: request })}
      onLoadReminders={loadAgentReminders}
      onLoadReminderHistory={loadAgentReminderHistory}
      onLoadRuntimeOptions={async (computerId) => {
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
      }}
      onSaveRuntimeCredential={async (apiKey) => {
        await saveCredential({ data: { agentId: detail.id, apiKey } });
        await router.invalidate({ sync: true });
      }}
      onDeleteRuntimeCredential={async () => {
        await deleteCredential({ data: detail.id });
        await router.invalidate({ sync: true });
      }}
      onUpdate={async (input) => {
        await update({ data: input });
        await router.invalidate({ sync: true });
      }}
    />
  );
}
