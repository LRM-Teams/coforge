import { createContext, useContext, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  ChevronLeft,
  Hash01 as Hash,
  MessageSquare01 as MessagesSquare,
  Plus,
} from "@untitledui/icons";

import { PageHeader } from "@/components/layout/page-header";
import { AgentActivityAvatar } from "@/features/agents/agent-activity-avatar";
import {
  activityForAgent,
  type WorkspaceActivityView,
} from "@/features/agents/workspace-activity-realtime";
import { Button } from "@/components/ui/button";
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
 * band. The layout keeps both panels mounted so returning to the list retains
 * its scroll position and the selected conversation's draft.
 */
const BackToAgentsContext = createContext<(() => void) | undefined>(undefined);
const ConversationAgentStatusContext = createContext<"active" | "inactive" | undefined | null>(
  null,
);
const defaultActivity: WorkspaceActivityView = {
  activity: {},
  loading: false,
  error: false,
};
const ConversationActivityContext = createContext(defaultActivity);
const ConversationTimeZoneContext = createContext<string | undefined>(undefined);

export function useConversationActivity(agentId: string) {
  const view = useContext(ConversationActivityContext);
  return {
    ...activityForAgent(view, agentId),
    timeZone: useContext(ConversationTimeZoneContext),
  };
}

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
  activityView = defaultActivity,
  timeZone,
  children,
}: {
  agents: ConversationAgent[];
  selectedAgentId?: string;
  channels?: { id: string; name: string; joined: boolean }[];
  selectedChannelId?: string;
  onCreateChannel?: (name: string) => Promise<void>;
  activityView?: WorkspaceActivityView;
  timeZone?: string;
  children: ReactNode;
}) {
  const [showMobileAgents, setShowMobileAgents] = useState(!selectedAgentId && !selectedChannelId);
  const [createOpen, setCreateOpen] = useState(false);
  const listHidden = Boolean(selectedAgentId || selectedChannelId) && !showMobileAgents;
  const selectedAgentStatus = agents.find((agent) => agent.id === selectedAgentId)?.status.value;

  return (
    <main className="flex h-svh min-w-0 md:gap-2 md:p-2">
      <nav
        aria-label={m.messages_agent_list_label()}
        className={cn(
          "min-w-0 flex-col overflow-hidden bg-card md:flex md:w-72 md:shrink-0 md:rounded-xl md:border xl:w-80",
          listHidden ? "hidden" : "flex w-full",
        )}
      >
        <PageHeader heading={m.messages_title()} />

        <div className="flex-1 overflow-y-auto px-3 py-4">
          <div className="mb-2 flex h-8 items-center justify-between px-3">
            <h2 className="text-xs font-semibold text-muted-foreground">{m.channels_title()}</h2>
            {onCreateChannel && (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={m.channel_create()}
                onClick={() => setCreateOpen(true)}
              >
                <Plus aria-hidden="true" className="size-4" />
              </Button>
            )}
          </div>
          <ul aria-label={m.channels_title()} className="mb-6 space-y-1">
            {channels.map((channel) => (
              <li key={channel.id}>
                <Link
                  to="/messages/channels/$channelId"
                  params={{ channelId: channel.id }}
                  aria-current={channel.id === selectedChannelId ? "page" : undefined}
                  resetScroll={false}
                  onClick={() => setShowMobileAgents(false)}
                  className={cn(
                    "flex min-w-0 items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                    channel.id === selectedChannelId && "bg-brand/10 text-brand",
                  )}
                >
                  <Hash aria-hidden="true" className="size-5 shrink-0" />
                  <span className="truncate">{channel.name}</span>
                  {channel.joined && (
                    <span className="ml-auto rounded-md border bg-card px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
                      {m.channel_joined()}
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
          <h2 className="px-3 pb-2 text-xs font-semibold text-muted-foreground">
            {m.messages_agents_action()}
          </h2>
          <ul className="space-y-1">
            {agents.map((agent) => {
              const selected = agent.id === selectedAgentId;
              return (
                <li
                  key={agent.id}
                  className={cn(
                    "flex min-w-0 items-center gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-muted",
                    selected && "bg-brand/10",
                  )}
                >
                  <AgentActivityAvatar
                    agent={agent}
                    size="lg"
                    status={agent.status.value}
                    {...activityForAgent(activityView, agent.id)}
                    timeZone={timeZone}
                  />
                  <Link
                    to="/messages/$agentId"
                    params={{ agentId: agent.id }}
                    aria-current={selected ? "page" : undefined}
                    resetScroll={false}
                    onClick={() => setShowMobileAgents(false)}
                    className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-md py-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    <span
                      className={cn("truncate text-sm font-semibold", selected && "text-brand")}
                    >
                      {agent.displayName}
                    </span>
                    <span className="truncate text-sm text-muted-foreground">@{agent.name}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      </nav>

      <section
        className={cn(
          "min-w-0 flex-1 flex-col overflow-hidden bg-card md:flex md:rounded-xl md:border",
          listHidden ? "flex" : "hidden",
        )}
      >
        <BackToAgentsContext value={() => setShowMobileAgents(true)}>
          <ConversationAgentStatusContext value={selectedAgentStatus}>
            <ConversationActivityContext value={activityView}>
              <ConversationTimeZoneContext value={timeZone}>{children}</ConversationTimeZoneContext>
            </ConversationActivityContext>
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
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={back}
      aria-label={m.messages_title()}
      className="-ml-2 size-11 shrink-0 md:hidden"
    >
      <ChevronLeft aria-hidden="true" className="size-5" />
    </Button>
  );
}

export function EmptyConversation() {
  return (
    <div className="grid h-full place-content-center justify-items-center px-6 text-center">
      <div className="mb-5 flex size-12 items-center justify-center rounded-xl border bg-card shadow-xs">
        <MessagesSquare aria-hidden="true" className="size-6 text-muted-foreground" />
      </div>
      <p className="text-lg font-semibold">{m.messages_empty_title()}</p>
      <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
        {m.messages_empty_description()}
      </p>
    </div>
  );
}
