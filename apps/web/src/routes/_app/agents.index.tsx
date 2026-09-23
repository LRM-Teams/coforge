import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect } from "react";
import { z } from "zod";

import { PageLoadError } from "@/features/errors/page-load-error";
import { AgentsContent } from "@/features/agents/agents-content";
import { AgentsPending } from "@/features/agents/agents-pending";
import {
  createAgent,
  deleteAgent,
  ensureWeeklyReportAssistantMember,
} from "@/features/agents/agents.functions";
import { useLiveAgents } from "@/features/agents/workspace-agents-realtime";
import { getComputerRuntimeCatalog, listComputers } from "@/features/computers/computers.functions";
import { inviteWorkspaceMember } from "@/features/workspaces/members.functions";
import { listWorkspaceMembers } from "@/features/workspaces/workspaces.functions";
import {
  agentIdFromProfileParam,
  agentProfileParamSchema,
  agentProfileTabParamSchema,
} from "@/features/agents/profile-panel/profile-panel-search";

export const Route = createFileRoute("/_app/agents/")({
  validateSearch: z.object({
    memberType: z.enum(["agent", "human"]).default("agent").catch("agent"),
    owner: z.enum(["all", "mine"]).default("all").catch("all"),
    /** A Computer id, or "none" for Agents without a Computer; absent means every Computer. */
    computer: z
      .string()
      .min(1)
      .refine((value) => value !== "all")
      .optional()
      .catch(undefined),
    profile: agentProfileParamSchema,
    agentTab: agentProfileTabParamSchema,
  }),
  // The Agent list itself comes from the layout loader and stays live there.
  loader: async () => {
    // Members is where Users configure the weekly-report assistant; ensure it exists here
    // (not in the global `_app` listAgents loader, which must stay failure-isolated).
    const [assistant, computers, directory] = await Promise.all([
      ensureWeeklyReportAssistantMember(),
      listComputers(),
      listWorkspaceMembers(),
    ]);
    return { computers, directory, weeklyReportAssistantAgentId: assistant.agentId };
  },
  pendingComponent: AgentsPending,
  errorComponent: PageLoadError,
  component: AgentsPage,
});

function AgentsPage() {
  const { computers, directory, weeklyReportAssistantAgentId } = Route.useLoaderData();
  const { memberType, owner, computer, profile, agentTab } = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const create = useServerFn(createAgent);
  const loadRuntimeCatalog = useServerFn(getComputerRuntimeCatalog);
  const invite = useServerFn(inviteWorkspaceMember);
  const removeAgent = useServerFn(deleteAgent);
  const visibleAgents = useLiveAgents();

  // Refresh the shell Agent list once so a just-ensured weekly-report assistant appears.
  useEffect(() => {
    if (!weeklyReportAssistantAgentId) return;
    if (visibleAgents.some((agent) => agent.id === weeklyReportAssistantAgentId)) return;
    void router.invalidate({ sync: true });
  }, [weeklyReportAssistantAgentId, visibleAgents, router]);

  return (
    <AgentsContent
      directory={directory}
      memberType={memberType}
      owner={owner}
      computer={computer}
      onFiltersChange={(filters) => {
        void navigate({
          search: (previous) => ({ ...previous, ...filters }),
          resetScroll: false,
        });
      }}
      agents={visibleAgents}
      computers={computers}
      profileAgentId={agentIdFromProfileParam(profile)}
      agentTab={agentTab}
      onLoadRuntimeCatalog={(computerId) => loadRuntimeCatalog({ data: { computerId } })}
      onCreate={async (data) => {
        const result = await create({ data });
        await router.invalidate({ sync: true });
        return result;
      }}
      onInviteMember={async (data) => {
        await invite({ data });
      }}
      onDeleteAgent={async (agentId, confirmation) => {
        await removeAgent({ data: { agentId, confirmation } });
        await router.invalidate({ sync: true });
      }}
    />
  );
}
