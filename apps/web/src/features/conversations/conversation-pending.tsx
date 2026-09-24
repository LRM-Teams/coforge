import { useEffect } from "react";
import { useMatch, useNavigate, useRouter } from "@tanstack/react-router";
import { AlertCircle } from "@untitledui/icons";
import { Button } from "#src/components/base/buttons/button";
import { Skeleton } from "#src/components/ui/skeleton";
import { isAppError } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import { MESSAGE_COLUMN_CLASS } from "#src/features/settings/message-width";
import { ConversationListButton } from "./conversation-navigation";
import { isConversationGone } from "./conversation-queries";
import { useRefreshSidebarChannels } from "./sidebar-lists";

export function MessagesPending() {
  return (
    <main className="flex h-svh min-w-0 flex-col bg-primary">
      <ConversationPending />
    </main>
  );
}

export function ConversationPending() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-secondary px-4 md:px-6">
        <ConversationListButton />
        <p role="status" className="sr-only">
          {m.conversation_loading()}
        </p>
      </header>
      <div
        aria-busy="true"
        aria-label={m.conversation_history()}
        className="min-h-0 flex-1 overflow-hidden"
      >
        {/* The same reading column as the loaded stream, so rows do not jump sideways on load. */}
        <div
          aria-hidden="true"
          className={`${MESSAGE_COLUMN_CLASS} space-y-8 p-4 motion-safe:animate-pulse md:p-6`}
        >
          {["w-4/5", "w-3/5", "w-2/3", "w-1/2"].map((width) => (
            <div key={width} className="flex gap-3">
              <Skeleton className="size-8 shrink-0 rounded-full" />
              <div className="min-w-0 flex-1 space-y-2.5 pt-1">
                <Skeleton className="h-3 w-24" />
                <Skeleton className={`h-3 ${width}`} />
                <Skeleton className="h-3 w-2/5" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ConversationLoadError({ error }: { error: unknown }) {
  const router = useRouter();
  const routeId = useMatch({ strict: false, select: (match) => match.routeId });
  const navigate = useNavigate();
  const refreshSidebarChannels = useRefreshSidebarChannels();
  const gone = isConversationGone(error);
  // A conversation that no longer exists for the viewer (a channel hidden from the Workspace)
  // leaves for Chat, which opens the viewer's next conversation. The channel list is re-read
  // first, so Chat does not land straight back on the channel that just went away.
  useEffect(() => {
    if (!gone) return;
    void refreshSidebarChannels().finally(() => void navigate({ to: "/messages", replace: true }));
  }, [gone, navigate, refreshSidebarChannels]);
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
