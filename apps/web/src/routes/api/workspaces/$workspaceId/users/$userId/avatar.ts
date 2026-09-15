import { createFileRoute } from "@tanstack/react-router";
import { handleWorkspaceUserAvatar } from "../../../../../../server/profiles/workspace-user-avatar.server";

export const Route = createFileRoute("/api/workspaces/$workspaceId/users/$userId/avatar")({
  server: {
    handlers: {
      GET: ({ request, params }) =>
        handleWorkspaceUserAvatar(request, params.workspaceId, params.userId),
    },
  },
});
