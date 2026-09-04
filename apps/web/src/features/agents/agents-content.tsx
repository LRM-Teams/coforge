import { useEffect, useRef, useState, type FormEvent } from "react";
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
import type { CodeAgentModelMetadata } from "@coforge/protocol";
import { AgentCard, type AgentView } from "./agent-card";
import type { CreateAgentInput } from "./agent.schemas";

type ComputerOption = {
  id: string;
  machineId: string;
  online?: boolean;
  runtimes: { provider: string }[];
};

type RuntimeCatalog = { provider: string; models: CodeAgentModelMetadata[] };

function runtimeProvider(value: FormDataEntryValue | null): CreateAgentInput["provider"] {
  if (value === "pi") return "pi";
  if (value === "codex") return "codex";
  if (value === "claude-code") return "claude-code";
  return "coforge";
}

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
  const [provider, setProvider] = useState<CreateAgentInput["provider"]>("coforge");
  const [modelProvider, setModelProvider] = useState("");
  const [modelKey, setModelKey] = useState("");
  const [catalogsByComputer, setCatalogsByComputer] = useState<
    Record<string, RuntimeCatalog[] | undefined>
  >({});
  const [catalogLoadError, setCatalogLoadError] = useState<string>();
  const [catalogRetry, setCatalogRetry] = useState(0);
  const loadingCatalogs = useRef(new Set<string>());
  const selectedComputer = computers.find((computer) => computer.id === computerId);
  const availableProviders = [
    "coforge",
    ...(selectedComputer?.runtimes.map((runtime) => runtime.provider) ?? []),
  ];
  const runtimeCatalogs = catalogsByComputer[computerId];
  const selectedCatalog = runtimeCatalogs?.find((catalog) => catalog.provider === provider);
  const modelProviders = [
    ...new Set(
      (selectedCatalog?.models ?? [])
        .map((model) => model.modelProvider)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const selectedModel = selectedCatalog?.models.find(
    (model) => modelOptionValue(model) === modelKey && model.modelProvider === modelProvider,
  );
  const filteredAgents = agents.filter((agent) =>
    `${agent.displayName} ${agent.name}`.toLowerCase().includes(search.trim().toLowerCase()),
  );

  useEffect(() => {
    if (
      !open ||
      !computerId ||
      catalogsByComputer[computerId] !== undefined ||
      loadingCatalogs.current.has(computerId)
    )
      return;
    loadingCatalogs.current.add(computerId);
    void onLoadRuntimeCatalog(computerId)
      .then((catalogs) => {
        setCatalogsByComputer((current) => ({ ...current, [computerId]: catalogs }));
        setCatalogLoadError((current) => (current === computerId ? undefined : current));
      })
      .catch(() => setCatalogLoadError(computerId))
      .finally(() => loadingCatalogs.current.delete(computerId));
  }, [catalogRetry, catalogsByComputer, computerId, onLoadRuntimeCatalog, open]);

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
      const manualCatalog = catalogLoadError === computerId;
      const result = await onCreate({
        name,
        description,
        provider,
        model: manualCatalog ? String(form.get("model") ?? "").trim() : selectedModel?.id,
        modelProvider: manualCatalog
          ? String(form.get("modelProvider") ?? "").trim() || undefined
          : modelProvider || undefined,
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
                        setProvider("coforge");
                        setModelProvider("");
                        setModelKey("");
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
                <div className="grid min-w-0 gap-1.5 text-sm">
                  <span>{m.agent_form_provider()}</span>
                  <Select
                    name="provider"
                    value={provider}
                    onValueChange={(value) => {
                      if (value !== null) {
                        setProvider(runtimeProvider(value));
                        setModelProvider("");
                        setModelKey("");
                      }
                    }}
                  >
                    <SelectTrigger aria-label={m.agent_form_provider()} className="h-9 min-w-0">
                      <SelectValue>
                        {() =>
                          provider === "coforge"
                            ? m.agent_provider_pi_builtin()
                            : provider === "pi"
                              ? "Pi"
                              : provider === "codex"
                                ? "Codex"
                                : "Claude Code"
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="coforge">{m.agent_provider_pi_builtin()}</SelectItem>
                      {availableProviders.includes("pi") && <SelectItem value="pi">Pi</SelectItem>}
                      {availableProviders.includes("codex") && (
                        <SelectItem value="codex">Codex</SelectItem>
                      )}
                      {availableProviders.includes("claude-code") && (
                        <SelectItem value="claude-code">Claude Code</SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                </div>
                {catalogLoadError === computerId ? (
                  <label className="grid min-w-0 gap-1.5 text-sm">
                    {m.agent_form_model_provider()}
                    <input
                      name="modelProvider"
                      required={provider === "coforge"}
                      maxLength={100}
                      className="h-9 min-w-0 rounded-md border bg-background px-3 outline-none focus:ring-2 focus:ring-ring/30"
                    />
                  </label>
                ) : (
                  provider === "coforge" && (
                    <div className="grid min-w-0 gap-1.5 text-sm">
                      <span>
                        {m.agent_form_model_provider()}{" "}
                        <span className="sr-only">{m.agent_optional()}</span>
                      </span>
                      <Select
                        name="modelProvider"
                        disabled={!runtimeCatalogs}
                        value={modelProvider}
                        onValueChange={(value) => {
                          if (value !== null) {
                            setModelProvider(value);
                            setModelKey("");
                          }
                        }}
                      >
                        <SelectTrigger
                          aria-label={m.agent_form_model_provider()}
                          className="h-9 min-w-0"
                        >
                          <SelectValue>
                            {() => modelProvider || m.agent_form_provider_default()}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="">{m.agent_form_provider_default()}</SelectItem>
                          {modelProviders.map((value) => (
                            <SelectItem key={value} value={value}>
                              {value}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )
                )}
                {catalogLoadError === computerId ? (
                  <label className="grid min-w-0 gap-1.5 text-sm">
                    {m.agent_form_model()}
                    <input
                      name="model"
                      required
                      maxLength={200}
                      className="h-9 min-w-0 rounded-md border bg-background px-3 outline-none focus:ring-2 focus:ring-ring/30"
                    />
                  </label>
                ) : (
                  <div className="grid min-w-0 gap-1.5 text-sm">
                    <span>
                      {m.agent_form_model()} <span className="sr-only">{m.agent_optional()}</span>
                    </span>
                    <Select
                      name="model"
                      disabled={!runtimeCatalogs}
                      value={modelKey}
                      onValueChange={(value) => value !== null && setModelKey(value)}
                    >
                      <SelectTrigger
                        aria-label={`${m.agent_form_model()} ${m.agent_optional()}`}
                        className="h-9 min-w-0"
                      >
                        <SelectValue>
                          {() =>
                            selectedModel
                              ? selectedModel.modelProvider
                                ? `${selectedModel.modelProvider} / ${selectedModel.displayName}`
                                : selectedModel.displayName
                              : m.agent_form_provider_default()
                          }
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="">{m.agent_form_provider_default()}</SelectItem>
                        {selectedCatalog?.models
                          .filter(
                            (model) =>
                              provider !== "coforge" || model.modelProvider === modelProvider,
                          )
                          .map((model) => (
                            <SelectItem
                              key={modelOptionValue(model)}
                              value={modelOptionValue(model)}
                            >
                              {model.modelProvider
                                ? `${model.modelProvider} / ${model.displayName}`
                                : model.displayName}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {catalogLoadError === computerId && (
                  <div
                    role="alert"
                    className="grid gap-2 text-sm text-destructive-text sm:col-span-2"
                  >
                    <span>{m.agent_form_catalog_manual_help()}</span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="justify-self-start"
                      onClick={() => {
                        setCatalogLoadError(undefined);
                        setCatalogRetry((current) => current + 1);
                      }}
                    >
                      {m.controls_retry()}
                    </Button>
                  </div>
                )}
                <div className="grid min-w-0 gap-1.5 text-sm sm:col-span-2">
                  <span>
                    {m.agent_form_reasoning()} <span className="sr-only">{m.agent_optional()}</span>
                  </span>
                  <Select name="reasoning" disabled={!selectedModel?.reasoningEfforts.length}>
                    <SelectTrigger
                      aria-label={`${m.agent_form_reasoning()} ${m.agent_optional()}`}
                      className="h-9 min-w-0 disabled:opacity-60"
                    >
                      <SelectValue>
                        {(value) => value || m.agent_form_provider_default()}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">{m.agent_form_provider_default()}</SelectItem>
                      {selectedModel?.reasoningEfforts.map((effort) => (
                        <SelectItem key={effort} value={effort}>
                          {effort}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
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

function modelOptionValue(model: CodeAgentModelMetadata): string {
  return JSON.stringify([model.modelProvider, model.id]);
}
