import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { ChannelConversation } from "@/features/conversations/channel-conversation";
import {
  loadPublicChannel,
  joinPublicChannel,
  sendPublicChannelMessage,
} from "@/features/conversations/channels.functions";

export const Route = createFileRoute("/_app/messages/channels/$channelId")({
  loader: ({ params }) => loadPublicChannel({ data: { channelId: params.channelId } }),
  component: ChannelPage,
});

function ChannelPage() {
  const conversation = Route.useLoaderData();
  const { channelId } = Route.useParams();
  const router = useRouter();
  const send = useServerFn(sendPublicChannelMessage);
  const join = useServerFn(joinPublicChannel);
  return (
    <ChannelConversation
      key={channelId}
      conversation={conversation}
      onSend={async (body, requestId, attachmentId) => {
        await send({ data: { channelId, body, requestId, attachmentId } });
        await router.invalidate({ sync: true });
      }}
      onJoin={async () => {
        await join({ data: { channelId } });
        await router.invalidate({ sync: true });
      }}
      onRefresh={() => router.invalidate({ sync: true })}
    />
  );
}
