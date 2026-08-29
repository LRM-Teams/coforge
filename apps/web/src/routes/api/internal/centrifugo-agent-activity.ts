import { createFileRoute } from "@tanstack/react-router";
import { CloudAgentUseCase } from "#/server/agents/cloud-agent.server";

// Publication proxy payloads are intentionally kept behind this server-only port.
// Durable run/event persistence is not yet part of the approved MVP schema.
const handler = new CloudAgentUseCase(
  { canUseAgent: async () => true },
  { publish: async () => {} },
  async (activity) => console.info("agent:activity", activity),
);

export const Route = createFileRoute("/api/internal/centrifugo-agent-activity")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = (await request.json()) as {
          b64data?: string;
          workspace_id?: string;
          agent_id?: string;
        };
        if (!body.b64data || !body.workspace_id || !body.agent_id)
          return new Response("invalid activity", { status: 400 });
        const bytes = Uint8Array.from(atob(body.b64data), (c) => c.charCodeAt(0));
        try {
          await handler.receiveActivity(bytes, {
            workspaceId: body.workspace_id,
            agentId: body.agent_id,
          });
          return new Response(null, { status: 204 });
        } catch {
          return new Response("activity rejected", { status: 403 });
        }
      },
    },
  },
});
