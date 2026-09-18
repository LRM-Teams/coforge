import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { PageLoadError } from "@/features/errors/page-load-error";
import { MembersLayout } from "@/features/agents/members-layout";
import { AgentsPending } from "@/features/agents/agents-pending";
import { createAgent } from "@/features/agents/agents.functions";
import { useLiveAgents } from "@/features/agents/workspace-agents-realtime";
import { getComputerRuntimeCatalog, listComputers } from "@/features/computers/computers.functions";
import { inviteWorkspaceMember } from "@/features/workspaces/members.functions";
import { listWorkspaceMembers } from "@/features/workspaces/workspaces.functions";

export const Route = createFileRoute("/_app/agents/")({
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
  const router = useRouter();
  const create = useServerFn(createAgent);
  const loadRuntimeCatalog = useServerFn(getComputerRuntimeCatalog);
  const invite = useServerFn(inviteWorkspaceMember);
  const visibleAgents = useLiveAgents();
  return (
    <MembersLayout
      directory={directory}
      agents={visibleAgents}
      computers={computers}
      onLoadRuntimeCatalog={(computerId) => loadRuntimeCatalog({ data: { computerId } })}
      onCreate={async (data) => {
        const result = await create({ data });
        await router.invalidate({ sync: true });
        return result;
      }}
      onInviteMember={async (data) => {
        await invite({ data });
      }}
    />
  );
}
