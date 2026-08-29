import { useState, type FormEvent } from "react";
import { Plus, Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogDescription,
  DialogPopup,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import { m } from "@/paraglide/messages";
import { AgentCard, type AgentView } from "./agent-card";

export type CreateAgentInput = {
  name: string;
  displayName: string;
  provider: "pi" | "codex" | "claude-code";
  model?: string;
  reasoning: string;
};

function runtimeProvider(value: FormDataEntryValue | null): CreateAgentInput["provider"] {
  if (value === "codex") return "codex";
  if (value === "claude-code") return "claude-code";
  return "pi";
}

export function AgentsContent({
  agents,
  onCreate,
  defaultCreateDialogOpen = false,
}: {
  agents: AgentView[];
  onCreate: (input: CreateAgentInput) => Promise<{ startPublished: boolean }>;
  defaultCreateDialogOpen?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(defaultCreateDialogOpen);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [deferredStart, setDeferredStart] = useState(false);
  const filteredAgents = agents.filter((agent) =>
    `${agent.displayName} ${agent.name}`.toLowerCase().includes(search.trim().toLowerCase()),
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const name = String(form.get("name") ?? "").trim();
    const displayName = String(form.get("displayName") ?? "").trim();
    if (!name || !displayName) {
      setError(m.agent_form_required_error());
      return;
    }
    setSubmitting(true);
    try {
      const result = await onCreate({
        name,
        displayName,
        provider: runtimeProvider(form.get("provider")),
        model: String(form.get("model") ?? "").trim() || undefined,
        reasoning: "",
      });
      formElement.reset();
      setOpen(false);
      setDeferredStart(!result.startPublished);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : m.agent_form_server_error());
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex-1 p-4 sm:p-5 md:p-6">
      <div className="flex flex-col items-start gap-4 sm:flex-row sm:justify-between sm:gap-6">
        <div>
          <span className="text-sm font-medium">{m.header_agents()}</span>
          <h1 className="text-xl font-semibold tracking-tight">{m.content_title()}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{m.content_description()}</p>
        </div>
        <Button onClick={() => setOpen(true)}>
          <Plus aria-hidden="true" data-icon="inline-start" />
          {m.header_new_agent()}
        </Button>
      </div>
      {deferredStart && (
        <p
          role="status"
          className="mt-5 rounded-lg border bg-muted px-4 py-3 text-sm text-muted-foreground"
        >
          {m.agent_deferred_start_notice()}
        </p>
      )}
      <label className="mt-6 flex h-9 w-full items-center gap-2 rounded-md border bg-background px-3 text-xs focus-within:ring-2 focus-within:ring-ring/30 sm:w-64">
        <Search aria-hidden="true" className="size-4 text-muted-foreground" />
        <input
          type="search"
          aria-label={m.filters_search()}
          placeholder={`${m.filters_search()}...`}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
        />
      </label>
      {filteredAgents.length ? (
        <section className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filteredAgents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} />
          ))}
        </section>
      ) : (
        <div className="mt-5 rounded-xl border border-dashed px-6 py-12 text-center">
          <p className="font-medium">
            {search ? m.agent_no_search_results() : m.agent_empty_title()}
          </p>
          {!search && (
            <p className="mt-1 text-sm text-muted-foreground">{m.agent_empty_description()}</p>
          )}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPortal keepMounted>
          <DialogBackdrop />
          <DialogPopup>
            <form onSubmit={submit}>
              <div className="flex items-start justify-between gap-6 px-6 pt-6">
                <div>
                  <DialogTitle>{m.agent_form_title()}</DialogTitle>
                  <DialogDescription className="mt-2">
                    {m.agent_form_description()}
                  </DialogDescription>
                </div>
                <DialogClose
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={m.controls_close()}
                    >
                      <X aria-hidden="true" />
                    </Button>
                  }
                />
              </div>
              <div className="grid gap-4 px-6 py-6 sm:grid-cols-2">
                <label className="grid gap-1.5 text-sm">
                  {m.agent_form_name()}
                  <input
                    name="name"
                    required
                    pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                    className="h-9 rounded-md border bg-background px-3 outline-none focus:ring-2 focus:ring-ring/30"
                  />
                </label>
                <label className="grid gap-1.5 text-sm">
                  {m.agent_form_display_name()}
                  <input
                    name="displayName"
                    required
                    className="h-9 rounded-md border bg-background px-3 outline-none focus:ring-2 focus:ring-ring/30"
                  />
                </label>
                <label className="grid gap-1.5 text-sm">
                  {m.agent_form_provider()}
                  <select
                    name="provider"
                    defaultValue="pi"
                    className="h-9 rounded-md border bg-background px-3"
                  >
                    <option value="pi">Pi</option>
                    <option value="codex">Codex</option>
                    <option value="claude-code">Claude Code</option>
                  </select>
                </label>
                <label className="grid gap-1.5 text-sm">
                  {m.agent_form_model()} <span className="sr-only">{m.agent_optional()}</span>
                  <input
                    name="model"
                    className="h-9 rounded-md border bg-background px-3 outline-none focus:ring-2 focus:ring-ring/30"
                  />
                </label>
                {error && (
                  <p role="alert" className="text-sm text-destructive sm:col-span-2">
                    {error}
                  </p>
                )}
              </div>
              <div className="flex justify-end gap-3 border-t px-6 py-4">
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                  {m.controls_cancel()}
                </Button>
                <Button type="submit" disabled={submitting}>
                  {submitting ? m.agent_form_submitting() : m.agent_form_submit()}
                </Button>
              </div>
            </form>
          </DialogPopup>
        </DialogPortal>
      </Dialog>
    </main>
  );
}
