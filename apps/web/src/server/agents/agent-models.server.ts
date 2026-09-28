import type { PrismaClient } from "#src/generated/prisma/client";
import { ACTIVE_AGENT_WHERE } from "./active-agent.server";
import { parseAgentRuntimeConfig } from "./agent-runtime-config.server";
import { visibleAgentWhere, type AgentVisibilityViewer } from "./agent-visibility.server";

/**
 * The configured model of every live Agent in the Workspace that `viewer` may see, by Agent id,
 * for the model shown beside an Agent's name in chat. Wider than `listAgents` (the viewer's own
 * roster): a channel shows messages from other members' public Agents too. An Agent left on its
 * runtime's default model, or whose stored config cannot be read, has no entry.
 */
export async function listVisibleAgentModels(
  db: Pick<PrismaClient, "agent">,
  workspaceId: string,
  viewer: AgentVisibilityViewer,
): Promise<Record<string, string>> {
  const rows = await db.agent.findMany({
    where: { workspaceId, ...ACTIVE_AGENT_WHERE, ...visibleAgentWhere(viewer) },
    select: { id: true, runtimeConfig: true },
  });
  const models: Record<string, string> = {};
  for (const row of rows) {
    let model: string;
    try {
      model = parseAgentRuntimeConfig(row.runtimeConfig).model.trim();
    } catch {
      continue;
    }
    if (model) models[row.id] = model;
  }
  return models;
}
