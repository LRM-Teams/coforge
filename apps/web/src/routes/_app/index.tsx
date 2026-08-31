import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { AgentsContent } from "@/features/agents/agents-content";
import { createAgent, listAgents } from "@/features/agents/agents.functions";
import { listComputers } from "@/features/computers/computers.functions";

export const Route = createFileRoute("/_app/")({
  loader: async () => {
    const [agents, computers] = await Promise.all([listAgents(), listComputers()]);
    return { agents, computers };
  },
  component: AgentsPage,
});

function AgentsPage() {
  const { agents, computers } = Route.useLoaderData();
  const router = useRouter();
  const create = useServerFn(createAgent);
  return (
    <AgentsContent
      agents={agents}
      computers={computers}
      onCreate={async (data) => {
        const result = await create({ data });
        await router.invalidate({ sync: true });
        return result;
      }}
    />
  );
}
