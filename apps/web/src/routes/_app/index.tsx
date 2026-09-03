import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { AppPageError } from "@/features/workspaces/workspace-unavailable";
import { AgentsContent } from "@/features/agents/agents-content";
import { createAgent, listAgents } from "@/features/agents/agents.functions";
import { listComputers } from "@/features/computers/computers.functions";
import { getUserPreferences } from "@/features/settings/settings.functions";

export const Route = createFileRoute("/_app/")({
  loader: async () => {
    const [agents, computers, preferences] = await Promise.all([
      listAgents(),
      listComputers(),
      getUserPreferences(),
    ]);
    return { agents, computers, timeZone: preferences.timeZone };
  },
  errorComponent: AppPageError,
  component: AgentsPage,
});

function AgentsPage() {
  const { agents, computers, timeZone } = Route.useLoaderData();
  const router = useRouter();
  const create = useServerFn(createAgent);
  return (
    <AgentsContent
      agents={agents}
      computers={computers}
      timeZone={timeZone}
      onCreate={async (data) => {
        const result = await create({ data });
        await router.invalidate({ sync: true });
        return result;
      }}
    />
  );
}
