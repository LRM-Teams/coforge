import { useEffect, useState } from "react";
import { CalendarDays, RotateCcw } from "lucide-react";
import { Link } from "@tanstack/react-router";

import { Avatar } from "@/components/ui/avatar";
import { Button, buttonVariants } from "@/components/ui/button";
import { m } from "@/paraglide/messages";
import { formatDateForDisplay } from "@/lib/dates";

export type AgentView = {
  id: string;
  name: string;
  displayName: string;
  createdAt: Date | string;
  runtimeConfig: {
    runtime: "pi" | "codex" | "claude-code";
    model: string;
  };
  status: "active" | "inactive";
  statusExpiresAt?: number | null;
};

const providerLabels = {
  pi: "Pi",
  codex: "Codex",
  "claude-code": "Claude Code",
};

const retryRequestCooldownMs = 3_000;

export function AgentCard({
  agent,
  timeZone,
  onRetry,
}: {
  agent: AgentView;
  timeZone: string | null;
  onRetry: (agentId: string) => Promise<void>;
}) {
  const createdAt = new Date(agent.createdAt);
  const [retrying, setRetrying] = useState(false);
  const [requested, setRequested] = useState(false);
  const [error, setError] = useState(false);
  const runtime = agent.runtimeConfig.model
    ? `${providerLabels[agent.runtimeConfig.runtime]} / ${agent.runtimeConfig.model}`
    : providerLabels[agent.runtimeConfig.runtime];

  useEffect(() => {
    if (agent.status === "active") {
      setRequested(false);
      return;
    }
    if (!requested) return;
    const timer = window.setTimeout(() => setRequested(false), retryRequestCooldownMs);
    return () => window.clearTimeout(timer);
  }, [agent.status, requested]);

  return (
    <article
      data-agent-card
      className="flex min-h-48 min-w-0 flex-col rounded-xl border bg-card p-4"
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar
            people={[{ name: agent.displayName }]}
            size="lg"
            online={agent.status === "active"}
          />
          <div className="min-w-0">
            <h2 className="text-base leading-tight font-semibold">
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
        </div>
        <Link
          to="/messages/$agentId"
          params={{ agentId: agent.id }}
          className={buttonVariants({ variant: "outline" })}
        >
          {m.agent_private_chat()}
        </Link>
      </div>
      <div className="mt-5 flex items-center justify-between gap-3">
        <div>
          <p className="text-sm text-card-foreground">{runtime}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {agent.status === "active" ? m.agent_status_online() : m.agent_status_offline()}
          </p>
        </div>
        {agent.status === "inactive" && !requested && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={retrying}
            onClick={async () => {
              setRetrying(true);
              setError(false);
              try {
                await onRetry(agent.id);
                setRequested(true);
              } catch {
                setError(true);
              } finally {
                setRetrying(false);
              }
            }}
          >
            <RotateCcw aria-hidden="true" data-icon="inline-start" />
            {retrying ? m.agent_retrying() : m.agent_retry_start()}
          </Button>
        )}
      </div>
      {requested && (
        <p className="mt-2 text-xs text-muted-foreground">{m.agent_start_requested()}</p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive-text">
          {m.agent_retry_error()}
        </p>
      )}
      <footer className="mt-auto flex items-center gap-2 border-t pt-3 text-xs text-muted-foreground">
        <CalendarDays aria-hidden="true" className="size-3.5" />
        <span>{m.agent_created()}</span>
        <time dateTime={createdAt.toISOString()}>{formatDateForDisplay(createdAt, timeZone)}</time>
      </footer>
    </article>
  );
}
