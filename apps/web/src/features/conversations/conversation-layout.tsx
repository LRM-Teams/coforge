import { createContext, useContext, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Hash, MessagesSquare, Plus } from "lucide-react";

import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";
import type { AgentStatusView } from "@/features/agents/agent-status-realtime";
import { CreateChannelDialog } from "./create-channel-dialog";

export type ConversationAgent = {
  id: string;
  name: string;
  displayName: string;
  status: AgentStatusView;
};

/**
 * Lets the conversation put the "back to the list" control in its own header
 * band. `/messages` redirects to the first agent, so the panes cannot be driven
 * by the URL; the layout owns the state and shares the way back.
 */
const BackToAgentsContext = createContext<(() => void) | undefined>(undefined);
const ConversationAgentStatusContext = createContext<"active" | "inactive" | undefined | null>(
  null,
);

/**
 * Two panels on the app's ground: the agent list and the conversation. Below
 * `md` they take turns, since only one fits.
 */
export function ConversationLayout({
  agents,
  selectedAgentId,
  channels = [],
  selectedChannelId,
  onCreateChannel,
  children,
}: {
  agents: ConversationAgent[];
  selectedAgentId?: string;
  channels?: { id: string; name: string; joined: boolean }[];
  selectedChannelId?: string;
  onCreateChannel?: (name: string) => Promise<void>;
  children: ReactNode;
}) {
  const [showMobileAgents, setShowMobileAgents] = useState(!selectedAgentId && !selectedChannelId);
  const [createOpen, setCreateOpen] = useState(false);
  const listHidden = Boolean(selectedAgentId || selectedChannelId) && !showMobileAgents;
  const selectedAgentStatus = agents.find((agent) => agent.id === selectedAgentId)?.status.value;

  return (
    <main className="flex h-svh min-w-0 gap-2 p-2">
      <nav
        aria-label={m.messages_agent_list_label()}
        className={cn(
          "min-w-0 flex-col overflow-hidden rounded-xl border bg-card md:flex md:w-72 md:shrink-0",
          listHidden ? "hidden" : "flex w-full",
        )}
      >
        <div className="flex h-14 shrink-0 items-center border-b px-5">
          <h1 className="text-base font-medium">{m.messages_title()}</h1>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          <div className="mb-1 flex h-9 items-center justify-between px-2.5">
            <h2 className="text-xs font-medium text-muted-foreground">{m.channels_title()}</h2>
            {onCreateChannel && (
              <button
                type="button"
                aria-label={m.channel_create()}
                onClick={() => setCreateOpen(true)}
                className="rounded-md p-1 hover:bg-muted"
              >
                <Plus aria-hidden="true" className="size-4" />
              </button>
            )}
          </div>
          <ul aria-label={m.channels_title()} className="mb-4">
            {channels.map((channel) => (
              <li key={channel.id}>
                <Link
                  to="/messages/channels/$channelId"
                  params={{ channelId: channel.id }}
                  aria-current={channel.id === selectedChannelId ? "page" : undefined}
                  onClick={() => setShowMobileAgents(false)}
                  className={cn(
                    "flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-2.5 text-sm hover:bg-muted",
                    channel.id === selectedChannelId && "bg-muted",
                  )}
                >
                  <Hash aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{channel.name}</span>
                  {channel.joined && (
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      {m.channel_joined()}
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
          <h2 className="px-2.5 py-2 text-xs font-medium text-muted-foreground">
            {m.messages_agents_action()}
          </h2>
          <ul>
            {agents.map((agent) => {
              const selected = agent.id === selectedAgentId;
              return (
                <li key={agent.id}>
                  <Link
                    to="/messages/$agentId"
                    params={{ agentId: agent.id }}
                    aria-current={selected ? "page" : undefined}
                    onClick={() => setShowMobileAgents(false)}
                    className={cn(
                      "flex min-w-0 items-center gap-3 rounded-lg px-2.5 py-2.5 hover:bg-muted",
                      selected && "bg-muted",
                    )}
                  >
                    <Avatar
                      people={[{ name: agent.displayName }]}
                      size="lg"
                      online={agent.status.value === "active"}
                      statusLabel={
                        agent.status.value === "active"
                          ? m.agent_status_online()
                          : m.agent_status_offline()
                      }
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="truncate text-xs font-medium">{agent.displayName}</span>
                      <span className="truncate text-xs text-muted-foreground">@{agent.name}</span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      </nav>

      <section
        className={cn(
          "min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card md:flex",
          showMobileAgents ? "hidden" : "flex",
        )}
      >
        <BackToAgentsContext value={() => setShowMobileAgents(true)}>
          <ConversationAgentStatusContext value={selectedAgentStatus}>
            {children}
          </ConversationAgentStatusContext>
        </BackToAgentsContext>
      </section>
      {onCreateChannel && (
        <CreateChannelDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreate={async (name) => {
            await onCreateChannel(name);
            setShowMobileAgents(false);
          }}
        />
      )}
    </main>
  );
}

export function useConversationAgentStatus() {
  const status = useContext(ConversationAgentStatusContext);
  if (status === null) throw new Error("ConversationAgentStatusContext is unavailable");
  return status;
}

/** Returns to the agent list on small screens, where only one panel fits. */
export function BackToAgents() {
  const back = useContext(BackToAgentsContext);
  if (!back) {
    return null;
  }

  return (
    <button
      type="button"
      onClick={back}
      aria-label={m.messages_title()}
      className="-ml-1 flex size-8 shrink-0 items-center justify-center rounded-lg hover:bg-muted md:hidden"
    >
      <MessagesSquare aria-hidden="true" className="size-4" />
    </button>
  );
}

export function EmptyConversation() {
  return (
    <div className="grid h-full place-content-center px-6 text-center">
      <MessagesSquare aria-hidden="true" className="mx-auto size-6 text-muted-foreground" />
      <p className="mt-3 font-medium">{m.messages_empty_title()}</p>
      <p className="mt-1 text-sm text-muted-foreground">{m.messages_empty_description()}</p>
    </div>
  );
}
