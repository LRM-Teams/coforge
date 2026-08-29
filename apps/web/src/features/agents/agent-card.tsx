import { CalendarDays } from "lucide-react";
import { Link } from "@tanstack/react-router";

import { buttonVariants } from "@/components/ui/button";
import { m } from "@/paraglide/messages";

export type AgentView = {
  id: string;
  name: string;
  displayName: string;
  createdAt: Date | string;
  runtimeConfig: {
    provider: "pi" | "codex" | "claude-code";
    model: string;
  };
};

const providerLabels = {
  pi: "Pi",
  codex: "Codex",
  "claude-code": "Claude Code",
};

export function AgentCard({ agent }: { agent: AgentView }) {
  const createdAt = new Date(agent.createdAt);
  const runtime = agent.runtimeConfig.model
    ? `${providerLabels[agent.runtimeConfig.provider]} / ${agent.runtimeConfig.model}`
    : providerLabels[agent.runtimeConfig.provider];

  return (
    <article
      data-agent-card
      className="flex min-h-48 min-w-0 flex-col rounded-xl border bg-card p-4"
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold">
            <Link
              to="/agents/$agentId"
              params={{ agentId: agent.id }}
              search={{ tab: "profile" }}
              className="hover:underline"
            >
              {agent.displayName}
            </Link>
          </h2>
          <p className="truncate text-xs text-muted-foreground">@{agent.name}</p>
        </div>
        <Link
          to="/messages/$agentId"
          params={{ agentId: agent.id }}
          className={buttonVariants({ variant: "outline" })}
        >
          {m.agent_private_chat()}
        </Link>
      </div>
      <p className="mt-5 text-sm text-card-foreground">{runtime}</p>
      <footer className="mt-auto flex items-center gap-2 border-t pt-3 text-xs text-muted-foreground">
        <CalendarDays aria-hidden="true" className="size-3.5" />
        <span>{m.agent_created()}</span>
        <time dateTime={createdAt.toISOString()}>{createdAt.toLocaleDateString()}</time>
      </footer>
    </article>
  );
}
