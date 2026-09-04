import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { DirectConversation } from "@/features/conversations/direct-conversation";
import { useConversationAgentStatus } from "@/features/conversations/conversation-layout";
import {
  loadDirectConversation,
  sendDirectConversationMessage,
} from "@/features/conversations/conversations.functions";

export const Route = createFileRoute("/_app/messages/$agentId")({
  loader: ({ params }) => loadDirectConversation({ data: { agentId: params.agentId } }),
  component: DirectConversationPage,
});

function DirectConversationPage() {
  const conversation = Route.useLoaderData();
  const agentStatus = useConversationAgentStatus();
  const { agentId } = Route.useParams();
  const router = useRouter();
  const send = useServerFn(sendDirectConversationMessage);

  return (
    <DirectConversation
      key={conversation.agent.id}
      conversation={conversation}
      agentStatus={agentStatus}
      onSend={async (body, requestId, attachmentId) => {
        await send({ data: { agentId, requestId, body, attachmentId } });
        await router.invalidate({ sync: true });
      }}
      onRefresh={() => router.invalidate({ sync: true })}
    />
  );
}
