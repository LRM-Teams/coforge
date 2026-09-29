import { useEffect } from "react";
import { useMatch, useNavigate, useRouter } from "@tanstack/react-router";
import { AlertCircle } from "@untitledui/icons";
import { Button } from "#src/components/base/buttons/button";
import { isAppError } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { ConversationListButton } from "./conversation-list-button";
import { ConversationPending } from "./conversation-pending";
import { isConversationGone } from "./conversation-queries";
import { useRefreshSidebarChannels } from "./sidebar-lists";

export function ConversationLoadError({ error }: { error: unknown }) {
  const router = useRouter();
  const routeId = useMatch({ strict: false, select: (match) => match.routeId });
  const navigate = useNavigate();
  const workspaceSlug = useWorkspaceSlug();
  const refreshSidebarChannels = useRefreshSidebarChannels();
  const gone = isConversationGone(error);
  // A conversation that no longer exists for the viewer (a channel hidden from the Workspace)
  // leaves for Chat, which opens the viewer's next conversation. The channel list is re-read
  // first, so Chat does not land straight back on the channel that just went away.
  useEffect(() => {
    if (!gone) return;
    void refreshSidebarChannels().finally(
      () => void navigate({ to: "/w/$workspaceSlug", params: { workspaceSlug }, replace: true }),
    );
  }, [gone, navigate, workspaceSlug, refreshSidebarChannels]);
  if (gone) return <ConversationPending />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-secondary px-4 md:px-6">
        <ConversationListButton />
        <h1 className="text-base font-semibold">{m.messages_title()}</h1>
      </header>
      <div className="grid flex-1 place-content-center gap-4 p-6 text-center">
        <AlertCircle aria-hidden="true" className="mx-auto size-5 text-error-primary" />
        <p role="alert" className="text-sm">
          {m.conversation_history_load_error()}
        </p>
        {isAppError(error) && error.errorId && (
          <p className="text-xs text-tertiary">{m.error_reference({ errorId: error.errorId })}</p>
        )}
        <Button
          color="secondary"
          className="justify-self-center"
          onPress={() => void router.invalidate({ filter: (match) => match.routeId === routeId })}
        >
          {m.controls_retry()}
        </Button>
      </div>
    </div>
  );
}
