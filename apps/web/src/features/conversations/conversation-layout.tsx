import { type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { MessagesSquare } from "lucide-react";

import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";

type ConversationAgent = { id: string; name: string; displayName: string };

/**
 * Two panels on the app's ground: the agent list and the conversation.
 *
 * Below `md` they take turns, driven by the URL rather than local state: the
 * list is the whole page at `/messages`, and opening an agent replaces it with
 * the conversation, which carries a way back.
 */
export function ConversationLayout({
  agents,
  selectedAgentId,
  children,
}: {
  agents: ConversationAgent[];
  selectedAgentId?: string;
  children: ReactNode;
}) {
  return (
    <main className="flex h-svh min-w-0 gap-2 p-2">
      <nav
        aria-label={m.messages_agent_list_label()}
        className={cn(
          "min-w-0 flex-col overflow-hidden rounded-xl border bg-card md:flex md:w-72 md:shrink-0",
          selectedAgentId ? "hidden" : "flex w-full",
        )}
      >
        <div className="flex h-14 shrink-0 items-center border-b px-5">
          <h1 className="text-base font-medium">{m.messages_title()}</h1>
        </div>

        <ul className="flex-1 overflow-y-auto p-2">
          {agents.map((agent) => {
            const selected = agent.id === selectedAgentId;
            return (
              <li key={agent.id}>
                <Link
                  to="/messages/$agentId"
                  params={{ agentId: agent.id }}
                  aria-current={selected ? "page" : undefined}
                  className={cn(
                    "flex min-w-0 items-center gap-3 rounded-lg px-2.5 py-2.5 hover:bg-muted",
                    selected && "bg-muted",
                  )}
                >
                  <Avatar people={[{ name: agent.displayName }]} size="lg" />
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="truncate text-xs font-medium">{agent.displayName}</span>
                    <span className="truncate text-xs text-muted-foreground">@{agent.name}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <section
        className={cn(
          "min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card md:flex",
          selectedAgentId ? "flex" : "hidden",
        )}
      >
        {children}
      </section>
    </main>
  );
}

/** Returns to the agent list on small screens, where only one panel fits. */
export function BackToAgents() {
  return (
    <Link
      to="/messages"
      aria-label={m.messages_agents_action()}
      className="-ml-1 flex size-8 shrink-0 items-center justify-center rounded-lg hover:bg-muted md:hidden"
    >
      <MessagesSquare aria-hidden="true" className="size-4" />
    </Link>
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
