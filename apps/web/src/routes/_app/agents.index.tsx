import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { PageLoadError } from "@/features/errors/page-load-error";
import { AgentsContent } from "@/features/agents/agents-content";
import { AgentsPending } from "@/features/agents/agents-pending";
import { createAgent } from "@/features/agents/agents.functions";
import { useLiveAgents } from "@/features/conversations/conversation-layout";
import { getComputerRuntimeCatalog, listComputers } from "@/features/computers/computers.functions";
import { listWorkspaceMembers } from "@/features/workspaces/workspaces.functions";

export const Route = createFileRoute("/_app/agents/")({
  validateSearch: z.object({
    memberType: z.enum(["all", "human", "agent"]).default("all").catch("all"),
  }),
  // The Agent list itself comes from the layout loader and stays live there.
  loader: async () => {
    const [computers, directory] = await Promise.all([listComputers(), listWorkspaceMembers()]);
    return { computers, directory };
  },
  pendingMs: 300,
  pendingMinMs: 0,
  pendingComponent: AgentsPending,
  errorComponent: PageLoadError,
  component: AgentsPage,
});

function AgentsPage() {
  const { computers, directory } = Route.useLoaderData();
  const { memberType } = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const create = useServerFn(createAgent);
  const loadRuntimeCatalog = useServerFn(getComputerRuntimeCatalog);
  const visibleAgents = useLiveAgents();
  return (
    <AgentsContent
      directory={directory}
      memberType={memberType}
      onMemberTypeChange={(value) => {
        void navigate({
          search: (previous) => ({ ...previous, memberType: value }),
          resetScroll: false,
        });
      }}
      agents={visibleAgents}
      computers={computers}
      onLoadRuntimeCatalog={(computerId) => loadRuntimeCatalog({ data: { computerId } })}
      onCreate={async (data) => {
        const result = await create({ data });
        await router.invalidate({ sync: true });
        return result;
      }}
    />
  );
}
