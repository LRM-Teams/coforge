import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect } from "react";
import { z } from "zod";

import { PageLoadError } from "#src/features/errors/page-load-error";
import { AgentsContent } from "#src/features/agents/agents-content";
import { AgentsPending } from "#src/features/agents/agents-pending";
import {
  createAgent,
  deleteAgent,
  ensureWeeklyReportAssistantMember,
} from "#src/features/agents/agents.functions";
import { useLiveAgents } from "#src/features/agents/workspace-agents-realtime";
import {
  getComputerRuntimeCatalog,
  listComputers,
} from "#src/features/computers/computers.functions";
import { inviteWorkspaceMember } from "#src/features/workspaces/members.functions";
import { loadMemberDirectorySummary } from "#src/features/workspaces/workspaces.functions";
import {
  MEMBER_DIRECTORY_KEY,
  memberAgentsQuery,
  memberPeopleQuery,
} from "#src/features/agents/member-directory-queries";
import {
  agentIdFromProfileParam,
  agentProfileParamSchema,
  agentProfileTabParamSchema,
} from "#src/features/agents/profile-panel/profile-panel-search";

export const Route = createFileRoute("/_app/agents/")({
  validateSearch: z.object({
    memberType: z.enum(["agent", "human"]).default("agent").catch("agent"),
    owner: z.enum(["all", "mine"]).default("all").catch("all"),
    profile: agentProfileParamSchema,
    agentTab: agentProfileTabParamSchema,
  }),
  loaderDeps: ({ search }) => ({
    memberType: search.memberType,
    owner: search.owner,
  }),
  // Live Agent status comes from the layout's realtime provider; the directory itself is paged
  // through the Query cache, and the loader only makes the first page ready for this tab.
  loader: async ({ context, deps }) => {
    // Members is where Users configure the weekly-report assistant; ensure it exists here
    // (not in the global `_app` listAgents loader, which must stay failure-isolated).
    const [assistant, computers, summary] = await Promise.all([
      ensureWeeklyReportAssistantMember(),
      listComputers(),
      loadMemberDirectorySummary(),
    ]);
    await (deps.memberType === "agent"
      ? context.queryClient.ensureInfiniteQueryData(
          memberAgentsQuery(summary.workspaceId, {
            owner: deps.owner,
            query: "",
          }),
        )
      : context.queryClient.ensureInfiniteQueryData(memberPeopleQuery(summary.workspaceId, "")));
    return { computers, summary, weeklyReportAssistantAgentId: assistant.agentId };
  },
  pendingComponent: AgentsPending,
  errorComponent: PageLoadError,
  component: AgentsPage,
});

function AgentsPage() {
  const { computers, summary, weeklyReportAssistantAgentId } = Route.useLoaderData();
  const { memberType, owner, profile, agentTab } = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const create = useServerFn(createAgent);
  const loadRuntimeCatalog = useServerFn(getComputerRuntimeCatalog);
  const invite = useServerFn(inviteWorkspaceMember);
  const removeAgent = useServerFn(deleteAgent);
  const visibleAgents = useLiveAgents();
  const queryClient = useQueryClient();
  // Counts, filter choices and every loaded page change together after a create, delete or invite.
  const refreshDirectory = async () => {
    await Promise.all([
      router.invalidate({ sync: true }),
      queryClient.invalidateQueries({ queryKey: MEMBER_DIRECTORY_KEY }),
    ]);
  };

  // Refresh the shell Agent list once so a just-ensured weekly-report assistant appears.
  useEffect(() => {
    if (!weeklyReportAssistantAgentId) return;
    if (visibleAgents.some((agent) => agent.id === weeklyReportAssistantAgentId)) return;
    void router.invalidate({ sync: true });
  }, [weeklyReportAssistantAgentId, visibleAgents, router]);

  return (
    <AgentsContent
      summary={summary}
      memberType={memberType}
      owner={owner}
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
        await refreshDirectory();
        return result;
      }}
      onInviteMember={async (data) => {
        await invite({ data });
        await refreshDirectory();
      }}
      onDeleteAgent={async (agentId, confirmation) => {
        await removeAgent({ data: { agentId, confirmation } });
        await refreshDirectory();
      }}
    />
  );
}
