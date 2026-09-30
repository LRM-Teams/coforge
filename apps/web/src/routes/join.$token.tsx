import { createFileRoute } from "@tanstack/react-router";

import { getSignedInAccount } from "#src/features/auth/current-user.functions";
import { inspectWorkspaceJoinLink } from "#src/features/workspaces/join-links.functions";
import { JoinWorkspacePage } from "#src/features/workspaces/join-workspace-page";
import { isAppError } from "#src/lib/app-error";

/**
 * An invite link. Outside the Workspace layout on purpose: the visitor may be signed out or in no
 * Workspace yet. An unknown, revoked, expired or used-up link loads as `preview: null`.
 */
export const Route = createFileRoute("/join/$token")({
  loader: async ({ params }) => {
    const [preview, viewerAccount] = await Promise.all([
      inspectWorkspaceJoinLink({ data: { token: params.token } }).catch((error: unknown) => {
        if (isAppError(error) && error.code === "NOT_FOUND") return null;
        throw error;
      }),
      getSignedInAccount(),
    ]);
    return { preview, viewerAccount };
  },
  // Whether the link still works, and who is looking, must never come from a cache.
  staleTime: 0,
  gcTime: 0,
  component: Join,
});

function Join() {
  const { token } = Route.useParams();
  const { preview, viewerAccount } = Route.useLoaderData();
  return (
    <JoinWorkspacePage key={token} token={token} preview={preview} viewerAccount={viewerAccount} />
  );
}
