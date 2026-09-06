import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { DirectConversation } from "@/features/conversations/direct-conversation";
import { useConversationAgentStatus } from "@/features/conversations/conversation-layout";
import {
  loadDirectConversation,
  markDirectThreadRead,
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
  const markRead = useServerFn(markDirectThreadRead);

  return (
    <DirectConversation
      key={conversation.agent.id}
      conversation={conversation}
      agentStatus={agentStatus}
      onSend={async (body, requestId, attachmentId, threadRootId) => {
        await send({ data: { agentId, requestId, body, attachmentId, threadRootId } });
        await router.invalidate({ sync: true });
      }}
      onReadThread={(threadRootId, throughSequence) =>
        markRead({ data: { agentId, threadRootId, throughSequence } })
      }
      onRefresh={() => router.invalidate({ sync: true })}
    />
  );
}
