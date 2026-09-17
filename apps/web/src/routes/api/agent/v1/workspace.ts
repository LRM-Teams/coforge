import { createFileRoute } from "@tanstack/react-router";
import { agentAuthMiddleware } from "#/server/agents/agent-http.middleware";
import { buildAgentRuntimeContext } from "#/server/agents/agent-runtime-context.server";
import { parseAgentRuntimeConfig } from "#/server/agents/agent-runtime-config.server";

export const Route = createFileRoute("/api/agent/v1/workspace")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      GET: async ({ context: { principal, db } }) => {
        try {
          const [workspace, humans, agents, projects, self] = await Promise.all([
            db.workspace.findUnique({
              where: { id: principal.workspaceId },
              select: { id: true, name: true, slug: true },
            }),
            db.workspaceMembership.findMany({
              where: { workspaceId: principal.workspaceId },
              select: {
                userId: true,
                role: true,
                user: { select: { username: true, displayName: true } },
              },
              orderBy: { user: { username: "asc" } },
            }),
            db.agent.findMany({
              where: { workspaceId: principal.workspaceId },
              select: { id: true, name: true, displayName: true, description: true },
              orderBy: { name: "asc" },
            }),
            db.project.findMany({
              where: { workspaceId: principal.workspaceId },
              select: {
                id: true,
                name: true,
                slug: true,
                githubFullName: true,
                githubHtmlUrl: true,
              },
              orderBy: { createdAt: "asc" },
            }),
            db.agent.findUnique({
              where: {
                id_workspaceId: { id: principal.agentId, workspaceId: principal.workspaceId },
              },
              select: {
                id: true,
                name: true,
                runtimeConfig: true,
                computerId: true,
                computer: {
                  select: {
                    name: true,
                    displayName: true,
                    platform: true,
                    osVersion: true,
                    computerVersion: true,
                  },
                },
              },
            }),
          ]);
          if (!workspace) return Response.json({ error: "workspace not found" }, { status: 404 });
          return Response.json({
            workspace,
            humans: humans.map((human) => ({
              name: human.user.username,
              displayName: human.user.displayName?.trim() || human.user.username,
              role: human.role,
            })),
            agents: agents.map((agent) => ({
              name: agent.name,
              displayName: agent.displayName,
              description: agent.description,
              status: "unknown",
              activity: null,
              activityDetail: null,
              role: agent.id === principal.agentId ? "self" : null,
            })),
            projects,
            ...buildSelfRuntimeContext(self, workspace),
          });
        } catch {
          return new Response("unauthorized", { status: 401 });
        }
      },
    },
  },
});

type SelfAgent = {
  id: string;
  name: string;
  runtimeConfig: unknown;
  computerId: string | null;
  computer: {
    name: string;
    displayName: string;
    platform: string | null;
    osVersion: string | null;
    computerVersion: string | null;
  } | null;
} | null;

/**
 * The calling Agent's own `runtimeContext`: the same Workspace/Computer mapping the launch-config
 * response sends (`agent-api-keys.ts`'s `buildAgentLaunchIdentity`), plus this Agent's identity and
 * runtime-config selection. Never includes another Agent's runtime config. Omitted entirely when
 * nothing is known, so an older CLI's defensive decoder degrades cleanly.
 */
function buildSelfRuntimeContext(
  self: SelfAgent,
  workspace: { id: string; slug: string; name: string },
) {
  if (!self) return {};
  let runtime: string | undefined;
  let model: string | undefined;
  let reasoning: string | undefined;
  try {
    const config = parseAgentRuntimeConfig(self.runtimeConfig);
    runtime = config.runtime || undefined;
    model = config.model.trim() || undefined;
    reasoning = config.reasoning.trim() || undefined;
  } catch {
    // An unparsable runtime config never fails workspace info; it only omits these fields.
  }
  const runtimeContext = {
    ...(self.id ? { agentId: self.id } : {}),
    ...(self.name ? { agentName: self.name } : {}),
    ...(runtime ? { runtime } : {}),
    ...(model ? { model } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...buildAgentRuntimeContext({
      workspaceId: workspace.id,
      workspace: { slug: workspace.slug, name: workspace.name },
      computerId: self.computerId,
      computer: self.computer,
    }),
  };
  return Object.keys(runtimeContext).length > 0 ? { runtimeContext } : {};
}
