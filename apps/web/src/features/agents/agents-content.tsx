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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { m } from "@/paraglide/messages";
import { AgentCard, type AgentView } from "./agent-card";
import { AgentRuntimeFields, type RuntimeCatalog } from "./agent-runtime-fields";
import type { CreateAgentInput } from "./agent.schemas";

type ComputerOption = {
  id: string;
  machineId: string;
  online?: boolean;
  runtimes: { provider: string }[];
};

export function AgentsContent({
  agents,
  computers,
  timeZone = null,
  onCreate,
  onRetry,
  onLoadRuntimeCatalog,
  defaultCreateDialogOpen = false,
}: {
  agents: AgentView[];
  computers: ComputerOption[];
  timeZone?: string | null;
  onCreate: (input: CreateAgentInput) => Promise<{ startPublished: boolean }>;
  onRetry: (agentId: string) => Promise<void>;
  onLoadRuntimeCatalog: (computerId: string) => Promise<RuntimeCatalog[]>;
  defaultCreateDialogOpen?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(defaultCreateDialogOpen);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [deferredStart, setDeferredStart] = useState(false);
  const [computerId, setComputerId] = useState(computers[0]?.id ?? "");
  const selectedComputer = computers.find((computer) => computer.id === computerId);
  const filteredAgents = agents.filter((agent) =>
    `${agent.displayName} ${agent.name}`.toLowerCase().includes(search.trim().toLowerCase()),
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const name = String(form.get("name") ?? "").trim();
    const description = String(form.get("description") ?? "").trim();
    if (!name || !description) {
      setError(m.agent_form_required_error());
      return;
    }
    setSubmitting(true);
    try {
      const result = await onCreate({
        name,
        description,
        provider: runtimeProvider(form.get("provider")),
        model: String(form.get("model") ?? "").trim() || undefined,
        modelProvider: String(form.get("modelProvider") ?? "").trim() || undefined,
        reasoning: String(form.get("reasoning") ?? "").trim(),
        computerId: String(form.get("computerId") ?? ""),
      });
      formElement.reset();
      setOpen(false);
      setDeferredStart(!result.startPublished);
    } catch {
      setError(m.agent_form_server_error());
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
        <Button onClick={() => setOpen(true)} disabled={!computers.length}>
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
            <AgentCard
              key={`${agent.id}:${agent.status.value}`}
              agent={agent}
              timeZone={timeZone}
              onRetry={onRetry}
            />
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
                <div className="grid min-w-0 gap-1.5 text-sm sm:col-span-2">
                  <span>{m.agent_form_computer()}</span>
                  <Select
                    name="computerId"
                    required
                    value={computerId}
                    onValueChange={(value) => {
                      if (value !== null) {
                        setComputerId(value);
                      }
                    }}
                  >
                    <SelectTrigger aria-label={m.agent_form_computer()} className="h-9 min-w-0">
                      <SelectValue>{() => selectedComputer?.machineId}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {computers.map((computer) => (
                        <SelectItem key={computer.id} value={computer.id}>
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="truncate">{computer.machineId}</span>
                            <span className="shrink-0 text-muted-foreground">
                              ·{" "}
                              {computer.online
                                ? m.computer_status_online()
                                : m.computer_status_offline()}
                            </span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <label className="grid min-w-0 gap-1.5 text-sm sm:col-span-2">
                  {m.agent_form_name()}
                  <input
                    name="name"
                    required
                    pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                    placeholder="release-fix"
                    className="h-9 min-w-0 rounded-md border bg-background px-3 outline-none focus:ring-2 focus:ring-ring/30"
                  />
                </label>
                <label className="grid min-w-0 gap-1.5 text-sm sm:col-span-2">
                  {m.agent_form_description()}
                  <textarea
                    name="description"
                    required
                    rows={3}
                    placeholder={m.agent_form_description_placeholder()}
                    className="min-w-0 resize-y rounded-md border bg-background px-3 py-2 outline-none focus:ring-2 focus:ring-ring/30"
                  />
                </label>
                <AgentRuntimeFields
                  key={computerId}
                  open={open}
                  computerId={computerId}
                  onLoad={async (id) => ({
                    providers:
                      computers
                        .find((computer) => computer.id === id)
                        ?.runtimes.map((runtime) => runtime.provider) ?? [],
                    catalogs: await onLoadRuntimeCatalog(id),
                  })}
                />
                {error && (
                  <p role="alert" className="text-sm text-destructive-text sm:col-span-2">
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

function runtimeProvider(value: FormDataEntryValue | null): CreateAgentInput["provider"] {
  if (value === "pi" || value === "codex" || value === "claude-code") return value;
  return "coforge";
}
