import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback } from "react";

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
import {
  useWorkspaceAgent,
  useWorkspaceAgentActivity,
} from "@/features/conversations/conversation-layout";

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
  const { detail, timeZone } = Route.useLoaderData();
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
  const liveAgent = useWorkspaceAgent(detail.id);
  const activity = useWorkspaceAgentActivity(detail.id).activity;
  const loadAgentSkills = useCallback(
    () => loadSkills({ data: detail.id }),
    [loadSkills, detail.id],
  );
  const loadAgentReminders = useCallback(
    (cursor?: { id: string }) =>
      loadReminders({ data: { agentId: detail.id, ...(cursor ? { cursor } : {}) } }),
    [detail.id, loadReminders],
  );
  return (
    <AgentDetail
      activity={activity.length ? activity : detail.activity}
      detail={{ ...detail, ...(liveAgent?.display ? { display: liveAgent.display } : {}) }}
      timeZone={timeZone}
      tab={Route.useSearch().tab}
      environment={{
        onLoad: () => loadEnvironment({ data: detail.id }),
        onSave: async (envVars) => {
          const result = await saveEnvironment({ data: { agentId: detail.id, envVars } });
          await router.invalidate({ sync: true });
          return result;
        },
      }}
      onLoadSkills={loadAgentSkills}
      onExecuteControl={(request) => executeControl({ data: request })}
      onLoadReminders={loadAgentReminders}
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
