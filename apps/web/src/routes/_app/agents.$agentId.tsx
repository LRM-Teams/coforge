import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { MembersLayout } from "@/features/agents/members-layout";
import { createAgent } from "@/features/agents/agents.functions";
import { AgentsPending } from "@/features/agents/agents-pending";
import { AgentProfilePanel } from "@/features/agents/profile-panel/agent-profile-panel";
import { agentProfileQuery } from "@/features/agents/profile-panel/agent-profile-queries";
import { agentProfileTabParamSchema } from "@/features/agents/profile-panel/profile-panel-search";
import { useLiveAgents } from "@/features/agents/workspace-agents-realtime";
import { PageLoadError } from "@/features/errors/page-load-error";
import { getComputerRuntimeCatalog, listComputers } from "@/features/computers/computers.functions";
import { inviteWorkspaceMember } from "@/features/workspaces/members.functions";
import { listWorkspaceMembers } from "@/features/workspaces/workspaces.functions";
import { localizeHref } from "@/paraglide/runtime";

export const Route = createFileRoute("/_app/agents/$agentId")({
  validateSearch: z.object({ agentTab: agentProfileTabParamSchema }),
  loader: async ({ context, params }) => {
    const [computers, directory] = await Promise.all([listComputers(), listWorkspaceMembers()]);
    // Prefetches the panel's own query so the profile renders in the initial SSR HTML — the
    // Members page no longer runs the old full-page `getAgentDetail` loader.
    await context.queryClient.ensureQueryData(agentProfileQuery(params.agentId));
    return { computers, directory };
  },
  pendingMs: 300,
  pendingMinMs: 0,
  pendingComponent: AgentsPending,
  errorComponent: PageLoadError,
  component: AgentDetailPage,
});

function AgentDetailPage() {
  const { computers, directory } = Route.useLoaderData();
  const { agentId } = Route.useParams();
  const { agentTab } = Route.useSearch();
  const navigate = Route.useNavigate();
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
      selectedAgentId={agentId}
      onLoadRuntimeCatalog={(computerId) => loadRuntimeCatalog({ data: { computerId } })}
      onCreate={async (data) => {
        const result = await create({ data });
        await router.invalidate({ sync: true });
        return result;
      }}
      onInviteMember={async (data) => {
        await invite({ data });
      }}
      detail={
        <AgentProfilePanel
          agentId={agentId}
          requestedTab={agentTab}
          onTabChange={(tab) => void navigate({ search: { agentTab: tab }, replace: true })}
          onClose={() => void navigate({ to: "/agents", search: {} })}
          hideClose
          backHref={localizeHref("/agents")}
        />
      }
    />
  );
}
