import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { AgentDetail } from "@/features/agents/agent-detail";
import {
  deleteAgentRuntimeCredential,
  getAgentDetail,
  saveAgentRuntimeCredential,
  updateAgent,
} from "@/features/agents/agents.functions";
import { m } from "@/paraglide/messages";
import { getUserPreferences } from "@/features/settings/settings.functions";
import { PageLoadError } from "@/features/errors/page-load-error";
import { getComputerRuntimeCatalog, listComputers } from "@/features/computers/computers.functions";

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
  errorComponent: PageLoadError,
  component: AgentDetailPage,
});

function AgentDetailPage() {
  const { detail, timeZone } = Route.useLoaderData();
  const router = useRouter();
  const saveCredential = useServerFn(saveAgentRuntimeCredential);
  const deleteCredential = useServerFn(deleteAgentRuntimeCredential);
  const update = useServerFn(updateAgent);
  const loadComputers = useServerFn(listComputers);
  const loadCatalog = useServerFn(getComputerRuntimeCatalog);
  return (
    <AgentDetail
      detail={detail}
      timeZone={timeZone}
      tab={Route.useSearch().tab}
      onLoadRuntimeOptions={async (computerId) => {
        const [computers, catalogs] = await Promise.all([
          loadComputers(),
          loadCatalog({ data: { computerId } }),
        ]);
        return {
          providers:
            computers
              .find((computer) => computer.id === computerId)
              ?.runtimes.map((runtime) => runtime.provider) ?? [],
          catalogs,
        };
      }}
      onSaveRuntimeCredential={async (apiKey) => {
        await saveCredential({ data: { agentId: detail.id, apiKey } });
        await router.invalidate({ sync: true });
      }}
      onDeleteRuntimeCredential={async () => {
        await deleteCredential({ data: detail.id });
        await router.invalidate({ sync: true });
      }}
      onUpdate={async (input) => {
        await update({ data: input });
        await router.invalidate({ sync: true });
      }}
    />
  );
}
