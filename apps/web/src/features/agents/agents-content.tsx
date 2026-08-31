import { useState, type FormEvent } from "react";
import { Plus, Search, X } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
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
import type { CodeAgentModelMetadata } from "@coforge/protocol";
import { AgentCard, type AgentView } from "./agent-card";

export type CreateAgentInput = {
  name: string;
  displayName: string;
  provider: "pi" | "codex" | "claude-code";
  model?: string;
  modelProvider?: string;
  reasoning: string;
  computerId: string;
};

type ComputerOption = {
  id: string;
  machineId: string;
  runtimes: { provider: string }[];
  modelCatalogs: { provider: string; models: CodeAgentModelMetadata[] }[];
};

function runtimeProvider(value: FormDataEntryValue | null): CreateAgentInput["provider"] {
  if (value === "codex") return "codex";
  if (value === "claude-code") return "claude-code";
  return "pi";
}

export function AgentsContent({
  agents,
  computers,
  timeZone = null,
  onCreate,
  defaultCreateDialogOpen = false,
}: {
  agents: AgentView[];
  computers: ComputerOption[];
  timeZone?: string | null;
  onCreate: (input: CreateAgentInput) => Promise<{ startPublished: boolean }>;
  defaultCreateDialogOpen?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(defaultCreateDialogOpen);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [deferredStart, setDeferredStart] = useState(false);
  const [computerId, setComputerId] = useState(computers[0]?.id ?? "");
  const [provider, setProvider] = useState<CreateAgentInput["provider"]>("pi");
  const [modelKey, setModelKey] = useState("");
  const selectedComputer = computers.find((computer) => computer.id === computerId);
  const availableProviders = [
    "pi",
    ...(selectedComputer?.runtimes.map((runtime) => runtime.provider) ?? []),
  ];
  const selectedCatalog = selectedComputer?.modelCatalogs.find(
    (catalog) => catalog.provider === provider,
  );
  const selectedModel = selectedCatalog?.models.find(
    (model) => modelOptionValue(model) === modelKey,
  );
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
        provider,
        model: selectedModel?.id,
        modelProvider: selectedModel?.modelProvider || undefined,
        reasoning: String(form.get("reasoning") ?? "").trim(),
        computerId: String(form.get("computerId") ?? ""),
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
    <main className="flex-1 p-2">
      <div className="min-h-[calc(100svh_-_1rem)] overflow-hidden rounded-xl border bg-card">
        <PageHeader
          heading={m.content_title()}
          actions={
            <Button onClick={() => setOpen(true)} disabled={!computers.length}>
              <Plus aria-hidden="true" data-icon="inline-start" />
              {m.header_new_agent()}
            </Button>
          }
        />
        <div className="p-4 sm:p-5 md:p-6">
          <p className="text-sm text-muted-foreground">{m.content_description()}</p>
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
                <AgentCard key={agent.id} agent={agent} timeZone={timeZone} />
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
                    <label className="grid min-w-0 gap-1.5 text-sm sm:col-span-2">
                      {m.agent_form_computer()}
                      <select
                        name="computerId"
                        required
                        value={computerId}
                        onChange={(event) => {
                          setComputerId(event.target.value);
                          setProvider("pi");
                          setModelKey("");
                        }}
                        className="h-9 min-w-0 rounded-md border bg-background px-3"
                      >
                        {computers.map((computer) => (
                          <option key={computer.id} value={computer.id}>
                            {computer.machineId}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="grid min-w-0 gap-1.5 text-sm">
                      {m.agent_form_name()}
                      <input
                        name="name"
                        required
                        pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                        className="h-9 min-w-0 rounded-md border bg-background px-3 outline-none focus:ring-2 focus:ring-ring/30"
                      />
                    </label>
                    <label className="grid min-w-0 gap-1.5 text-sm">
                      {m.agent_form_display_name()}
                      <input
                        name="displayName"
                        required
                        className="h-9 min-w-0 rounded-md border bg-background px-3 outline-none focus:ring-2 focus:ring-ring/30"
                      />
                    </label>
                    <label className="grid min-w-0 gap-1.5 text-sm">
                      {m.agent_form_provider()}
                      <select
                        name="provider"
                        value={provider}
                        onChange={(event) => {
                          setProvider(runtimeProvider(event.target.value));
                          setModelKey("");
                        }}
                        className="h-9 min-w-0 rounded-md border bg-background px-3"
                      >
                        {availableProviders.includes("pi") && (
                          <option value="pi">{m.agent_provider_pi_builtin()}</option>
                        )}
                        {availableProviders.includes("codex") && (
                          <option value="codex">Codex</option>
                        )}
                        {availableProviders.includes("claude-code") && (
                          <option value="claude-code">Claude Code</option>
                        )}
                      </select>
                    </label>
                    <label className="grid min-w-0 gap-1.5 text-sm">
                      {m.agent_form_model()} <span className="sr-only">{m.agent_optional()}</span>
                      <select
                        name="model"
                        value={modelKey}
                        onChange={(event) => setModelKey(event.target.value)}
                        className="h-9 min-w-0 rounded-md border bg-background px-3"
                      >
                        <option value="">{m.agent_form_provider_default()}</option>
                        {selectedCatalog?.models.map((model) => (
                          <option key={modelOptionValue(model)} value={modelOptionValue(model)}>
                            {model.modelProvider
                              ? `${model.modelProvider} / ${model.displayName}`
                              : model.displayName}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="grid min-w-0 gap-1.5 text-sm sm:col-span-2">
                      {m.agent_form_reasoning()}{" "}
                      <span className="sr-only">{m.agent_optional()}</span>
                      <select
                        name="reasoning"
                        disabled={!selectedModel?.reasoningEfforts.length}
                        className="h-9 min-w-0 rounded-md border bg-background px-3 disabled:opacity-60"
                      >
                        <option value="">{m.agent_form_provider_default()}</option>
                        {selectedModel?.reasoningEfforts.map((effort) => (
                          <option key={effort} value={effort}>
                            {effort}
                          </option>
                        ))}
                      </select>
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
        </div>
      </div>
    </main>
  );
}

function modelOptionValue(model: CodeAgentModelMetadata): string {
  return JSON.stringify([model.modelProvider, model.id]);
}
