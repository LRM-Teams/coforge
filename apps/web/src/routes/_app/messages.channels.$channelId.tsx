import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
  ConversationLoadError,
  ConversationPending,
} from "#src/features/conversations/conversation-pending";
import { conversationPageSearchShape } from "#src/features/conversations/conversation-page-search";
import { finishedSummaryQuery } from "#src/features/tasks/use-finished-tasks";
import {
  ensureConversationWindow,
  publicChannelQuery,
} from "#src/features/conversations/conversation-queries";
import { ChannelConversationPage } from "#src/features/conversations/channel-conversation-page";

export const Route = createFileRoute("/_app/messages/channels/$channelId")({
  validateSearch: z.object({
    ...conversationPageSearchShape,
    message: z.uuid().optional().catch(undefined),
  }),
  loaderDeps: ({ search }) =>
    ({
      message: search.message,
      threadRootId: search.threadRootId,
      // The Tasks tab's finished-work window, whose counts the loader reads.
      tasks: search.view === "tasks" ? (search.completed ?? "week") : undefined,
    }) as const,
  remountDeps: ({ params }) => params.channelId,
  loader: async ({ context, params, deps, parentMatchPromise, cause }) => {
    const window = await ensureConversationWindow(
      context.queryClient,
      publicChannelQuery(params.channelId).query,
      deps.threadRootId ?? deps.message,
    );
    const conversationId = window.pages.at(-1)?.conversationId;
    if (deps.tasks && conversationId) {
      const completedWindow = deps.tasks;
      const summary = parentMatchPromise.then(({ loaderData }) =>
        context.queryClient.ensureQueryData(
          finishedSummaryQuery(
            { workspaceId: loaderData?.workspaceId ?? "", conversationId },
            completedWindow,
          ),
        ),
      );
      // Arriving from another kind of page (`enter`: a first load, or from a channel to a direct
      // message and back) waits for the counts. Staying on this kind of page (`stay`: switching to
      // the Tasks tab, changing the window, or opening another conversation of the same kind) only
      // starts the read: the board shows its loading state until the counts arrive
      // (`finished.pending`), so the page never gives way to its loading page for them.
      if (cause === "stay") void summary.catch(() => undefined);
      else await summary;
    }
    return window;
  },
  pendingComponent: ConversationPending,
  errorComponent: ConversationLoadError,
  component: ChannelPage,
});

function ChannelPage() {
  const { channelId } = Route.useParams();
  return <ChannelConversationPage channelId={channelId} search={Route.useSearch()} />;
}
