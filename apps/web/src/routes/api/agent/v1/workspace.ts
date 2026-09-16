import { createFileRoute } from "@tanstack/react-router";
import { agentAuthMiddleware } from "#/server/agents/agent-http.middleware";

export const Route = createFileRoute("/api/agent/v1/workspace")({
  server: {
    middleware: [agentAuthMiddleware],
    handlers: {
      GET: async ({ context: { principal, db } }) => {
        try {
          const [workspace, humans, agents, projects] = await Promise.all([
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
          });
        } catch {
          return new Response("unauthorized", { status: 401 });
        }
      },
    },
  },
});
