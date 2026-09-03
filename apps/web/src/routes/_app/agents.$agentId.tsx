import { createFileRoute } from "@tanstack/react-router";

import { AgentDetail } from "@/features/agents/agent-detail";
import { getAgentDetail } from "@/features/agents/agents.functions";
import { m } from "@/paraglide/messages";
import { getUserPreferences } from "@/features/settings/settings.functions";

function detailTab(value: unknown): "profile" | "activity" {
  if (value === "activity") return "activity";
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
  pendingComponent: () => (
    <main className="flex-1 p-6 text-sm text-muted-foreground">{m.agent_detail_loading()}</main>
  ),
  errorComponent: () => (
    <main className="flex-1 p-6">
      <div
        role="alert"
        className="rounded-xl border border-destructive/40 p-5 text-destructive-text"
      >
        {m.agent_detail_error()}
      </div>
    </main>
  ),
  component: AgentDetailPage,
});

function AgentDetailPage() {
  const { detail, timeZone } = Route.useLoaderData();
  return <AgentDetail detail={detail} timeZone={timeZone} tab={Route.useSearch().tab} />;
}
