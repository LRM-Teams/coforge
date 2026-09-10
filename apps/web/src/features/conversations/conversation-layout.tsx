import { createContext, useContext, type ReactNode } from "react";
import { MessageSquare01 as MessagesSquare } from "@untitledui/icons";

import {
  activityForAgent,
  type WorkspaceActivityView,
} from "@/features/agents/workspace-activity-realtime";
import { m } from "@/paraglide/messages";
import type { AgentStatusView } from "@/features/agents/agent-status-realtime";

export type ConversationAgent = {
  id: string;
  name: string;
  displayName: string;
  status: AgentStatusView;
};

const defaultActivity: WorkspaceActivityView = {
  activity: {},
  loading: false,
  error: false,
};

// Sourced once in AppLayout (see src/routes/_app.tsx) so the sidebar's Direct
// message list and any open conversation share a single realtime
// subscription instead of each mounting its own.
const LiveAgentsContext = createContext<ConversationAgent[]>([]);
const ConversationActivityContext = createContext(defaultActivity);
const ConversationTimeZoneContext = createContext<string | undefined>(undefined);

export function useConversationActivity(agentId: string) {
  const view = useContext(ConversationActivityContext);
  return {
    ...activityForAgent(view, agentId),
    timeZone: useContext(ConversationTimeZoneContext),
  };
}

/** The live Agent list (with realtime status), for the sidebar's Direct message section. */
export function useLiveAgents() {
  return useContext(LiveAgentsContext);
}

/** One Agent's live status, for the conversation page currently open on it. */
export function useConversationAgentStatus(agentId: string) {
  const agents = useContext(LiveAgentsContext);
  return agents.find((agent) => agent.id === agentId)?.status.value;
}

/**
 * Provides live Agent status, shared workspace activity, and the viewer's
 * time zone to the whole app: the sidebar's Direct message list and any open
 * conversation both read from this one subscription.
 */
export function ConversationRealtimeProvider({
  agents,
  activityView = defaultActivity,
  timeZone,
  children,
}: {
  agents: ConversationAgent[];
  activityView?: WorkspaceActivityView;
  timeZone?: string;
  children: ReactNode;
}) {
  return (
    <LiveAgentsContext value={agents}>
      <ConversationActivityContext value={activityView}>
        <ConversationTimeZoneContext value={timeZone}>{children}</ConversationTimeZoneContext>
      </ConversationActivityContext>
    </LiveAgentsContext>
  );
}

export function EmptyConversation() {
  return (
    <div className="grid h-full place-content-center justify-items-center px-6 text-center">
      <div className="mb-5 flex size-12 items-center justify-center rounded-xl border border-secondary bg-primary shadow-xs">
        <MessagesSquare aria-hidden="true" className="size-6 text-tertiary" />
      </div>
      <p className="text-lg font-semibold">{m.messages_empty_title()}</p>
      <p className="mt-2 max-w-sm text-sm leading-6 text-tertiary">
        {m.messages_empty_description()}
      </p>
    </div>
  );
}
