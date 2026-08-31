import { createFileRoute, getRouteApi, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { DirectConversation } from "@/features/conversations/direct-conversation";
import {
  loadDirectConversation,
  sendDirectConversationMessage,
} from "@/features/conversations/conversations.functions";

const messagesRouteApi = getRouteApi("/_app/messages");

export const Route = createFileRoute("/_app/messages/$agentId")({
  loader: ({ params }) => loadDirectConversation({ data: { agentId: params.agentId } }),
  component: DirectConversationPage,
});

function DirectConversationPage() {
  const conversation = Route.useLoaderData();
  const agents = messagesRouteApi.useLoaderData();
  const { agentId } = Route.useParams();
  const selectedAgent = agents.find((agent) => agent.id === agentId);
  const router = useRouter();
  const send = useServerFn(sendDirectConversationMessage);

  return (
    <DirectConversation
      key={selectedAgent?.id}
      conversation={conversation}
      onSend={async (body, requestId, attachmentId) => {
        await send({ data: { agentId, requestId, body, attachmentId } });
        await router.invalidate({ sync: true });
      }}
      onRefresh={() => router.invalidate({ sync: true })}
    />
  );
}
