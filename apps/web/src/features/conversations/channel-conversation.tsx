import { useState } from "react";
import { Hash } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BackToAgents } from "./conversation-layout";
import { ConversationPane, type DirectConversationView } from "./direct-conversation";
import { m } from "@/paraglide/messages";

export type ChannelConversationView = Omit<DirectConversationView, "agent" | "messages"> & {
  name: string;
  messages: (DirectConversationView["messages"][number] & { senderMemberId: string })[];
};

export function ChannelConversation({
  conversation,
  onSend,
  onJoin,
  onRefresh,
}: {
  conversation: ChannelConversationView;
  onSend: (body: string, requestId: string, attachmentId?: string) => Promise<void>;
  onJoin: () => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState(false);
  async function join() {
    setJoining(true);
    setError(false);
    try {
      await onJoin();
    } catch {
      setError(true);
    } finally {
      setJoining(false);
    }
  }
  return (
    <ConversationPane
      conversation={conversation}
      onSend={onSend}
      onRefresh={onRefresh}
      emptyDescription={m.channel_empty()}
      header={
        <header className="flex h-14 shrink-0 items-center gap-3 border-b px-3 sm:px-5">
          <BackToAgents />
          <Hash aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
          <h1 className="truncate text-base font-medium">#{conversation.name}</h1>
          <span className="ml-auto hidden text-xs text-muted-foreground sm:block">
            {m.channel_public()}
          </span>
        </header>
      }
      readOnlyNotice={
        !conversation.senderMemberId ? (
          <div className="m-5 flex flex-col items-start gap-3 rounded-xl border bg-muted/30 p-4">
            <p className="text-sm text-muted-foreground">{m.channel_public_description()}</p>
            {error && (
              <p role="alert" className="text-sm text-destructive-text">
                {m.channel_error()}
              </p>
            )}
            <Button disabled={joining} onClick={() => void join()}>
              {joining ? m.channel_joining() : m.channel_join()}
            </Button>
          </div>
        ) : undefined
      }
    />
  );
}
