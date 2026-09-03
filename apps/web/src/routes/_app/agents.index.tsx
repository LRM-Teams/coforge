import { useEffect, useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Centrifuge } from "centrifuge";

import { PageLoadError } from "@/features/errors/page-load-error";
import { AgentsContent } from "@/features/agents/agents-content";
import {
  createAgent,
  getAgentStatusConnectionToken,
  listAgents,
  retryAgentStart,
} from "@/features/agents/agents.functions";
import {
  agentStatusChannel,
  applyAgentStatusEvent,
  createAgentStatusConnectedHandler,
  decodeAgentStatusEvent,
  expireAgentStatuses,
} from "@/features/agents/agent-status-realtime";
import { listComputers } from "@/features/computers/computers.functions";
import { getUserPreferences } from "@/features/settings/settings.functions";

export const Route = createFileRoute("/_app/agents/")({
  loader: async () => {
    const [agents, computers, preferences] = await Promise.all([
      listAgents(),
      listComputers(),
      getUserPreferences(),
    ]);
    return { agents, computers, timeZone: preferences.timeZone };
  },
  errorComponent: PageLoadError,
  component: AgentsPage,
});

function AgentsPage() {
  const { agents, computers, timeZone } = Route.useLoaderData();
  const { currentWorkspace } = Route.useRouteContext();
  const router = useRouter();
  const create = useServerFn(createAgent);
  const retry = useServerFn(retryAgentStart);
  const refreshAgents = useServerFn(listAgents);
  const getConnectionToken = useServerFn(getAgentStatusConnectionToken);
  const [visibleAgents, setVisibleAgents] = useState(agents);
  useEffect(() => setVisibleAgents(agents), [agents]);
  useEffect(() => {
    const expiresAt = Math.min(
      ...visibleAgents.flatMap((agent) =>
        agent.status === "active" && agent.statusExpiresAt ? [agent.statusExpiresAt] : [],
      ),
    );
    if (!Number.isFinite(expiresAt)) return;
    const timer = setTimeout(
      () => setVisibleAgents((current) => expireAgentStatuses(current, Date.now())),
      Math.max(0, expiresAt - Date.now()) + 10,
    );
    return () => clearTimeout(timer);
  }, [visibleAgents]);
  useEffect(() => {
    if (!currentWorkspace) return;
    const channel = agentStatusChannel(currentWorkspace.id);
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const client = new Centrifuge(`${protocol}//${location.host}/connection/websocket`, {
      getToken: getConnectionToken,
    });
    const refreshSnapshot = createAgentStatusConnectedHandler(refreshAgents, setVisibleAgents);
    client.on("connected", () => {
      void refreshSnapshot().catch(() => {});
    });
    client.on("publication", (publication) => {
      if (publication.channel !== channel) return;
      try {
        const event = decodeAgentStatusEvent(publication.data);
        setVisibleAgents((current) => applyAgentStatusEvent(current, event));
      } catch {}
    });
    client.connect();
    return () => {
      client.disconnect();
    };
  }, [currentWorkspace, getConnectionToken, refreshAgents]);
  return (
    <AgentsContent
      agents={visibleAgents}
      computers={computers}
      timeZone={timeZone}
      onCreate={async (data) => {
        const result = await create({ data });
        await router.invalidate({ sync: true });
        return result;
      }}
      onRetry={async (agentId) => {
        await retry({ data: agentId });
        await router.invalidate({ sync: true });
      }}
    />
  );
}
