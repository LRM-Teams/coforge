import { createFileRoute, getRouteApi, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { PageLoadError } from "@/features/errors/page-load-error";
import { AgentsContent } from "@/features/agents/agents-content";
import {
  createAgent,
  getAgentStatusConnectionToken,
  listAgents,
  retryAgentStart,
} from "@/features/agents/agents.functions";
import { useAgentStatuses } from "@/features/agents/agent-status-realtime";
import { getComputerRuntimeCatalog, listComputers } from "@/features/computers/computers.functions";
import { getUserPreferences } from "@/features/settings/settings.functions";

const appRoute = getRouteApi("/_app");

export const Route = createFileRoute("/_app/agents/")({
  loader: async () => {
    const [agents, computers, preferences] = await Promise.all([
      listAgents(),
      listComputers(),
      getUserPreferences(),
    ]);
    return { agents, computers, timeZone: preferences.timeZone };
  },
  errorComponent: PageLoadError,
  component: AgentsPage,
});

function AgentsPage() {
  const { agents, computers, timeZone } = Route.useLoaderData();
  const { currentWorkspace } = appRoute.useLoaderData();
  const router = useRouter();
  const create = useServerFn(createAgent);
  const retry = useServerFn(retryAgentStart);
  const loadRuntimeCatalog = useServerFn(getComputerRuntimeCatalog);
  const refreshAgents = useServerFn(listAgents);
  const getConnectionToken = useServerFn(getAgentStatusConnectionToken);
  const visibleAgents = useAgentStatuses({
    agents,
    workspaceId: currentWorkspace?.id,
    refresh: refreshAgents,
    getConnectionToken,
  });
  return (
    <AgentsContent
      agents={visibleAgents}
      computers={computers}
      timeZone={timeZone}
      onLoadRuntimeCatalog={(computerId) => loadRuntimeCatalog({ data: { computerId } })}
      onCreate={async (data) => {
        const result = await create({ data });
        await router.invalidate({ sync: true });
        return result;
      }}
      onRetry={async (agentId) => {
        await retry({ data: agentId });
        await router.invalidate({ sync: true });
      }}
    />
  );
}
