import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { MessagesSquare } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";

type ConversationAgent = { id: string; name: string; displayName: string };

export function ConversationLayout({
  agents,
  selectedAgentId,
  children,
}: {
  agents: ConversationAgent[];
  selectedAgentId?: string;
  children: ReactNode;
}) {
  const [showMobileAgents, setShowMobileAgents] = useState(!selectedAgentId);

  return (
    <main className="flex min-h-0 flex-1 overflow-hidden">
      <aside
        className={cn(
          "w-full shrink-0 border-r bg-muted/20 md:block md:w-64 lg:w-72",
          selectedAgentId && !showMobileAgents ? "hidden" : "block",
        )}
      >
        <div className="border-b px-4 py-4">
          <h1 className="text-lg font-semibold tracking-tight">{m.messages_title()}</h1>
        </div>
        <nav aria-label={m.messages_agent_list_label()} className="p-2">
          <ul className="space-y-1">
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
                      "flex min-w-0 items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-muted",
                      selected && "bg-muted",
                    )}
                  >
                    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                      {agent.displayName.trim().charAt(0).toUpperCase() || "?"}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">
                        {agent.displayName}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        @{agent.name}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </aside>

      <section
        className={cn(
          "min-w-0 flex-1 flex-col bg-background md:flex",
          showMobileAgents ? "hidden" : "flex",
        )}
      >
        {selectedAgentId && (
          <div className="border-b px-3 py-2 md:hidden">
            <Button variant="ghost" size="sm" onClick={() => setShowMobileAgents(true)}>
              <MessagesSquare aria-hidden="true" />
              {m.messages_agents_action()}
            </Button>
          </div>
        )}
        {children}
      </section>
    </main>
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
