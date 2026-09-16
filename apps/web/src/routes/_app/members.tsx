import { createFileRoute } from "@tanstack/react-router";
import { PageLoadError } from "@/features/errors/page-load-error";
import { WorkspaceMembersPanel } from "@/features/workspaces/workspace-members-panel";
import {
  loadMyWorkspaceInvitations,
  loadWorkspaceMembers,
} from "@/features/workspaces/members.functions";

export const Route = createFileRoute("/_app/members")({
  loader: async () => {
    const [members, incomingInvitations] = await Promise.all([
      loadWorkspaceMembers(),
      loadMyWorkspaceInvitations(),
    ]);
    return {
      actorUserId: members.actorUserId,
      actorRole: members.actorRole,
      members: members.members,
      pendingInvitations: members.pendingInvitations,
      incomingInvitations,
    };
  },
  errorComponent: PageLoadError,
  component: () => <WorkspaceMembersPanel {...Route.useLoaderData()} />,
});
