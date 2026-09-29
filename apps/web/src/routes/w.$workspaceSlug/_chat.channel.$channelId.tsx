import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ConversationLoadError } from "#src/features/conversations/conversation-load-error";
import { ConversationPending } from "#src/features/conversations/conversation-pending";
import { conversationPageSearchShape } from "#src/features/conversations/conversation-page-search";
import {
  conversationPageLoaderDeps,
  loadConversationPage,
} from "#src/features/conversations/conversation-page-loader";
import { ConversationPage } from "#src/features/conversations/conversation-page";

export const Route = createFileRoute("/w/$workspaceSlug/_chat/channel/$channelId")({
  validateSearch: z.object({
    ...conversationPageSearchShape,
    message: z.uuid().optional().catch(undefined),
  }),
  loaderDeps: ({ search }) => conversationPageLoaderDeps(search),
  remountDeps: ({ params }) => params.channelId,
  loader: ({ context, params, deps, parentMatchPromise, cause }) =>
    loadConversationPage(context.queryClient, { kind: "channel", id: params.channelId }, deps, {
      cause,
      workspaceId: () => parentMatchPromise.then(({ loaderData }) => loaderData?.workspaceId ?? ""),
    }),
  pendingComponent: ConversationPending,
  errorComponent: ConversationLoadError,
  component: ChannelConversationRoute,
});

function ChannelConversationRoute() {
  const { channelId } = Route.useParams();
  return (
    <ConversationPage target={{ kind: "channel", id: channelId }} search={Route.useSearch()} />
  );
}
