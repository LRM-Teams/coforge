import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { AgentsContent } from "@/features/agents/agents-content";
import { createAgent, listAgents } from "@/features/agents/agents.functions";

export const Route = createFileRoute("/_app/")({
  loader: () => listAgents(),
  component: AgentsPage,
});

function AgentsPage() {
  const agents = Route.useLoaderData();
  const router = useRouter();
  const create = useServerFn(createAgent);
  return (
    <AgentsContent
      agents={agents}
      onCreate={async (data) => {
        const result = await create({ data });
        await router.invalidate({ sync: true });
        return result;
      }}
    />
  );
}
