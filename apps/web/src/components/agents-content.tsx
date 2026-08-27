import { ChevronDown, Plus, Search } from "lucide-react";

import { AgentCard } from "@/components/agent-card";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";

function getAgents() {
  return [
    [
      "Atlas",
      "hr-assistant",
      m.agent_atlas_role(),
      m.agent_atlas_description(),
      "PengdeMacBook",
      "James",
      "AT",
      "bg-[#7556b9]",
    ],
    [
      "John",
      "product-designer-assistant",
      m.agent_john_role(),
      m.agent_john_description(),
      "docker-test0813",
      "Wangli",
      "JO",
      "bg-[#d18a38]",
    ],
    [
      "Judy",
      "backend",
      m.agent_judy_role(),
      m.agent_judy_description(),
      "FrankAns-MacBook",
      "James",
      "JU",
      "bg-[#b65757]",
    ],
    [
      "Mark",
      "markassistant",
      m.agent_mark_role(),
      m.agent_mark_description(),
      "PengdeMacBook",
      "James",
      "MA",
      "bg-[#5268b7]",
    ],
    [
      "Tick",
      "ui-designer-assistant",
      m.agent_tick_role(),
      m.agent_tick_description(),
      "docker-test0813",
      "Wangli",
      "TI",
      "bg-[#497665]",
    ],
    [
      "Tony",
      "Tonyassistant",
      m.agent_tony_role(),
      m.agent_tony_description(),
      "FrankAns-MacBook",
      "James",
      "TO",
      "bg-[#ba5937]",
    ],
  ] as const;
}

export function AgentsContent() {
  return (
    <main className="flex-1 p-4 sm:p-5 md:p-6">
      <div className="flex flex-col items-start gap-4 sm:flex-row sm:justify-between sm:gap-6">
        <div>
          <div className="flex items-center gap-2 text-sm sm:gap-3">
            <span className="font-medium">{m.header_agents()}</span>
            <span className="text-xs text-muted-foreground">24</span>
            <span className="hidden text-border sm:inline">/</span>
            <span className="hidden text-muted-foreground sm:inline">
              {m.header_collaborators()}
            </span>
            <span className="hidden text-xs text-muted-foreground sm:inline">21</span>
          </div>
          <h1 className="text-xl font-semibold tracking-tight">{m.content_title()}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{m.content_description()}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline">{m.content_archived_agents()}</Button>
          <Button>
            <Plus aria-hidden="true" data-icon="inline-start" />
            {m.header_new_agent()}
          </Button>
        </div>
      </div>
      <div className="mt-6 flex flex-wrap items-center gap-3 sm:mt-7">
        <div className="flex h-9 items-center rounded-md border bg-muted p-0.5 text-xs">
          <button className="h-7 rounded px-5 text-muted-foreground">{m.filters_mine()}</button>
          <button className="h-7 rounded border bg-background px-5 font-medium shadow-xs">
            {m.filters_all()}
          </button>
        </div>
        <button className="flex h-9 min-w-28 flex-1 items-center justify-between gap-4 rounded-md border bg-background px-3 text-xs sm:flex-none">
          {m.filters_computer()}
          <ChevronDown aria-hidden="true" className="size-3.5 text-muted-foreground" />
        </button>
        <label className="flex h-9 w-full items-center gap-2 rounded-md border bg-background px-3 text-xs focus-within:ring-2 focus-within:ring-ring/30 sm:w-64">
          <Search aria-hidden="true" className="size-4 text-muted-foreground" />
          <input
            type="search"
            aria-label={m.filters_search()}
            placeholder={`${m.filters_search()}...`}
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          />
        </label>
      </div>
      <section className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {getAgents().map(
          ([name, handle, role, description, computer, owner, initials, avatarClassName]) => (
            <AgentCard
              key={name}
              name={name}
              handle={handle}
              role={role}
              description={description}
              computer={computer}
              owner={owner}
              initials={initials}
              avatarClassName={avatarClassName}
            />
          ),
        )}
      </section>
    </main>
  );
}
