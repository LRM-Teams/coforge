import type { PrismaClient } from "#src/generated/prisma/client";
import { ACTIVE_AGENT_WHERE } from "./active-agent.server";
import { parseAgentRuntimeConfig } from "./agent-runtime-config.server";
import { visibleAgentWhere, type AgentVisibilityViewer } from "./agent-visibility.server";

/**
 * The configured model of every live Agent in the Workspace that `viewer` may see, by Agent id,
 * for the model shown beside an Agent's name in chat. Wider than `listAgents` (the viewer's own
 * roster): a channel shows messages from other members' public Agents too. Every such Agent has an
 * entry, so the browser can tell an Agent it has not heard of (read again) from one left on its
 * runtime's default model, or whose stored config cannot be read (`""`, nothing to show).
 * `readAt` is the server's clock, the one message times come from, so the browser compares a
 * message with the list without trusting its own clock.
 */
export async function listVisibleAgentModels(
  db: Pick<PrismaClient, "agent">,
  workspaceId: string,
  viewer: AgentVisibilityViewer,
  now: () => number = Date.now,
): Promise<{ readAt: number; models: Record<string, string> }> {
  // Taken before the read: the list covers every Agent that existed by `readAt`.
  const readAt = now();
  const rows = await db.agent.findMany({
    where: { workspaceId, ...ACTIVE_AGENT_WHERE, ...visibleAgentWhere(viewer) },
    select: { id: true, runtimeConfig: true },
  });
  const models: Record<string, string> = {};
  for (const row of rows) {
    try {
      models[row.id] = parseAgentRuntimeConfig(row.runtimeConfig).model.trim();
    } catch {
      models[row.id] = "";
    }
  }
  return { readAt, models };
}
