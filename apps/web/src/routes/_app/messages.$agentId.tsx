import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
  ConversationLoadError,
  ConversationPending,
} from "#src/features/conversations/conversation-pending";
import { conversationPageSearchShape } from "#src/features/conversations/conversation-page-search";
import {
  conversationPageLoaderDeps,
  loadConversationPage,
} from "#src/features/conversations/conversation-page-loader";
import { DirectConversationPage } from "#src/features/conversations/direct-conversation-page";

export const Route = createFileRoute("/_app/messages/$agentId")({
  validateSearch: z.object({
    ...conversationPageSearchShape,
    message: z.uuid().optional().catch(undefined),
  }),
  loaderDeps: ({ search }) => conversationPageLoaderDeps(search),
  remountDeps: ({ params }) => params.agentId,
  loader: ({ context, params, deps, parentMatchPromise, cause }) =>
    loadConversationPage(context.queryClient, { kind: "agent", id: params.agentId }, deps, {
      cause,
      workspaceId: () => parentMatchPromise.then(({ loaderData }) => loaderData?.workspaceId ?? ""),
    }),
  pendingComponent: ConversationPending,
  errorComponent: ConversationLoadError,
  component: DirectConversationRoute,
});

function DirectConversationRoute() {
  const { agentId } = Route.useParams();
  return <DirectConversationPage agentId={agentId} search={Route.useSearch()} />;
}
