import { createFileRoute, notFound } from "@tanstack/react-router";
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
import { ConversationPage } from "#src/features/conversations/conversation-page";
import { directConversationTargetQuery } from "#src/features/conversations/conversation-queries";

export const Route = createFileRoute("/w/$workspaceSlug/_chat/dm/$dmId")({
  validateSearch: z.object({
    ...conversationPageSearchShape,
    message: z.uuid().optional().catch(undefined),
  }),
  loaderDeps: ({ search }) => conversationPageLoaderDeps(search),
  remountDeps: ({ params }) => params.dmId,
  loader: async ({ context, params, deps, parentMatchPromise, cause }) => {
    const target = await context.queryClient.ensureQueryData(
      directConversationTargetQuery(params.dmId),
    );
    // A direct conversation between people has no page yet.
    if (target.kind !== "agent") throw notFound();
    await loadConversationPage(context.queryClient, { kind: "agent", id: target.agentId }, deps, {
      cause,
      workspaceId: () => parentMatchPromise.then(({ loaderData }) => loaderData?.workspaceId ?? ""),
    });
    return { agentId: target.agentId };
  },
  pendingComponent: ConversationPending,
  errorComponent: ConversationLoadError,
  component: DirectConversationRoute,
});

function DirectConversationRoute() {
  const { agentId } = Route.useLoaderData();
  return <ConversationPage target={{ kind: "agent", id: agentId }} search={Route.useSearch()} />;
}
