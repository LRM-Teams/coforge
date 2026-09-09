import { useEffect, useRef, useState } from "react";
import type { CodeAgentModelMetadata, RuntimeProvider } from "@coforge/protocol";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { m } from "@/paraglide/messages";
import { KEYED_MODEL_PROVIDERS } from "./agent.schemas";

export type RuntimeCatalog = {
  provider: string;
  models: CodeAgentModelMetadata[];
};
export type RuntimeOptions = {
  providers: string[];
  catalogs: RuntimeCatalog[];
};

type RuntimeSelection = {
  provider: RuntimeProvider;
  modelProvider: string;
  model: string;
  reasoning: string;
};

export function AgentRuntimeFields({
  open,
  computerId,
  initial,
  credentialConfigured = false,
  onLoad,
}: {
  open: boolean;
  computerId: string;
  initial?: RuntimeSelection;
  credentialConfigured?: boolean;
  onLoad: (computerId: string) => Promise<RuntimeOptions>;
}) {
  const [provider, setProvider] = useState(initial?.provider ?? "coforge");
  const [modelProvider, setModelProvider] = useState(initial?.modelProvider ?? "");
  const initialModelKey = initial?.model
    ? JSON.stringify([initial.modelProvider, initial.model])
    : "";
  const [modelKey, setModelKey] = useState(initialModelKey);
  const [reasoning, setReasoning] = useState(initial?.reasoning ?? "");
  const [apiKey, setApiKey] = useState("");
  const [optionsByComputer, setOptionsByComputer] = useState<
    Record<string, RuntimeOptions | undefined>
  >({});
  const [failedComputerId, setFailedComputerId] = useState<string>();
  const [retry, setRetry] = useState(0);
  const loading = useRef(new Set<string>());
  const previousComputerId = useRef(computerId);
  const options = optionsByComputer[computerId];
  const failed = failedComputerId === computerId;

  useEffect(() => {
    if (!open) setApiKey("");
  }, [open]);

  useEffect(() => {
    if (previousComputerId.current !== computerId) setApiKey("");
    previousComputerId.current = computerId;
  }, [computerId]);

  useEffect(() => {
    if (!open || !computerId || options || failed || loading.current.has(computerId)) return;
    loading.current.add(computerId);
    void onLoad(computerId)
      .then((value) => {
        setOptionsByComputer((current) => ({
          ...current,
          [computerId]: value,
        }));
        setFailedComputerId((current) => (current === computerId ? undefined : current));
        if (initial?.model) {
          const catalog = value.catalogs.find((item) => item.provider === initial.provider);
          const model = catalog?.models.find(
            (item) => item.id === initial.model && item.modelProvider === initial.modelProvider,
          );
          if (model) setModelKey(modelOptionValue(model));
        }
      })
      .catch(() => setFailedComputerId(computerId))
      .finally(() => {
        loading.current.delete(computerId);
      });
  }, [computerId, failed, initial, onLoad, open, options, retry]);

  const providers = new Set(["coforge", initial?.provider, ...(options?.providers ?? [])]);
  const catalogModels =
    provider === "pi" ? piCatalogModels(options) : runtimeModels(options, provider);
  const modelProviders = [
    ...new Set(
      catalogModels
        .map((model) => model.modelProvider)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const selectedModel = catalogModels.find(
    (model) =>
      modelOptionValue(model) === modelKey &&
      (provider !== "coforge" || model.modelProvider === modelProvider),
  );
  const configuredModelSelected = Boolean(
    initial?.model && provider === initial.provider && modelKey === initialModelKey,
  );
  const configuredModelLabel = configuredModelSelected
    ? [initial?.modelProvider, initial?.model].filter(Boolean).join(" / ")
    : undefined;
  const submittedModelProvider =
    provider === "coforge"
      ? modelProvider
      : (selectedModel?.modelProvider ??
        (modelKey === initialModelKey ? (initial?.modelProvider ?? "") : ""));
  const matchingConfiguredCredential =
    credentialConfigured &&
    initial?.provider === provider &&
    initial.modelProvider === modelProvider;
  const visibleModels = catalogModels.filter((model) => {
    if (provider === "coforge") return model.modelProvider === modelProvider;
    if (provider === "pi" && modelProvider) return model.modelProvider === modelProvider;
    return true;
  });

  return (
    <>
      <div className="grid min-w-0 gap-1.5 text-sm">
        <span>{m.agent_form_provider()}</span>
        <input type="hidden" name="provider" value={provider} />
        <Select
          value={provider}
          onValueChange={(value) => {
            if (value === null) return;
            setProvider(runtimeProvider(value));
            setModelProvider("");
            setModelKey("");
            setReasoning("");
            setApiKey("");
          }}
        >
          <SelectTrigger aria-label={m.agent_form_provider()} className="h-9 min-w-0">
            <SelectValue>{() => providerLabel(provider)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="coforge">{m.agent_provider_pi_builtin()}</SelectItem>
            {providers.has("pi") && <SelectItem value="pi">Pi</SelectItem>}
            {providers.has("codex") && <SelectItem value="codex">Codex</SelectItem>}
            {providers.has("claude-code") && (
              <SelectItem value="claude-code">Claude Code</SelectItem>
            )}
          </SelectContent>
        </Select>
      </div>
      {failed ? (
        <label className="grid min-w-0 gap-1.5 text-sm">
          {m.agent_form_model_provider()}
          <input
            name="modelProvider"
            required={provider === "coforge"}
            maxLength={100}
            value={modelProvider}
            onChange={(event) => {
              setModelProvider(event.target.value);
              setApiKey("");
            }}
            className="h-9 min-w-0 rounded-md border bg-background px-3"
          />
        </label>
      ) : (
        (provider === "coforge" || provider === "pi") && (
          <div className="grid min-w-0 gap-1.5 text-sm">
            <span>{m.agent_form_model_provider()}</span>
            <input type="hidden" name="modelProvider" value={modelProvider} />
            <Select
              disabled={!options}
              value={modelProvider}
              onValueChange={(value) => {
                if (value === null) return;
                setModelProvider(value);
                setModelKey("");
                setReasoning("");
                setApiKey("");
              }}
            >
              <SelectTrigger aria-label={m.agent_form_model_provider()} className="h-9 min-w-0">
                <SelectValue>{() => modelProvider || m.agent_form_provider_default()}</SelectValue>
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
      {!failed && provider !== "coforge" && provider !== "pi" && (
        <input type="hidden" name="modelProvider" value={submittedModelProvider} />
      )}
      {failed ? (
        <label className="grid min-w-0 gap-1.5 text-sm">
          {m.agent_form_model()}
          <input
            name="model"
            required
            maxLength={200}
            defaultValue={initial?.model}
            className="h-9 min-w-0 rounded-md border bg-background px-3"
          />
        </label>
      ) : (
        <div className="grid min-w-0 gap-1.5 text-sm">
          <span>{m.agent_form_model()}</span>
          <input
            type="hidden"
            name="model"
            value={
              selectedModel?.id ?? (modelKey === initialModelKey ? (initial?.model ?? "") : "")
            }
          />
          <Select
            disabled={!options}
            value={modelKey}
            onValueChange={(value) => {
              if (value === null) return;
              setModelKey(value);
              const model = catalogModels.find((item) => modelOptionValue(item) === value);
              if (model?.modelProvider !== modelProvider) setApiKey("");
              setModelProvider(model?.modelProvider ?? "");
              setReasoning(model?.defaultReasoning ?? "");
            }}
          >
            <SelectTrigger
              aria-label={`${m.agent_form_model()} ${m.agent_optional()}`}
              className="h-9 min-w-0"
            >
              <SelectValue>
                {() =>
                  selectedModel
                    ? `${selectedModel.modelProvider} / ${selectedModel.displayName}`
                    : (configuredModelLabel ?? m.agent_form_provider_default())
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">{m.agent_form_provider_default()}</SelectItem>
              {configuredModelSelected && !selectedModel && (
                <SelectItem value={initialModelKey}>{configuredModelLabel}</SelectItem>
              )}
              {visibleModels.map((model) => (
                <SelectItem key={modelOptionValue(model)} value={modelOptionValue(model)}>
                  {model.modelProvider
                    ? `${model.modelProvider} / ${model.displayName}`
                    : model.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {(provider === "coforge" || provider === "pi") &&
        KEYED_MODEL_PROVIDERS.has(modelProvider) && (
          <label className="grid min-w-0 gap-1.5 text-sm sm:col-span-2">
            {m.agent_runtime_api_key()}
            <input
              name="apiKey"
              type="password"
              aria-label={m.agent_runtime_api_key()}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              required={provider === "coforge" && !matchingConfiguredCredential}
              minLength={8}
              maxLength={4096}
              autoComplete="new-password"
              placeholder={m.agent_runtime_api_key_placeholder()}
              className="h-10 rounded-lg border bg-background px-3 shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <span className="text-xs font-normal text-muted-foreground">
              {matchingConfiguredCredential
                ? m.agent_form_api_key_preserve_help()
                : provider === "pi"
                  ? m.agent_form_pi_api_key_help()
                  : m.agent_form_coforge_api_key_help()}
            </span>
          </label>
        )}
      {failed && (
        <div role="alert" className="grid gap-2 text-sm text-destructive-text sm:col-span-2">
          <span>{m.agent_form_catalog_manual_help()}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="justify-self-start"
            onClick={() => {
              setFailedComputerId(undefined);
              setOptionsByComputer((current) => ({
                ...current,
                [computerId]: undefined,
              }));
              setRetry((value) => value + 1);
            }}
          >
            {m.controls_retry()}
          </Button>
        </div>
      )}
      <div className="grid min-w-0 gap-1.5 text-sm sm:col-span-2">
        <span>{m.agent_form_reasoning()}</span>
        <input type="hidden" name="reasoning" value={reasoning} />
        <Select
          disabled={!selectedModel?.reasoningEfforts.length}
          value={reasoning}
          onValueChange={(value) => value !== null && setReasoning(value)}
        >
          <SelectTrigger
            aria-label={`${m.agent_form_reasoning()} ${m.agent_optional()}`}
            className="h-9 min-w-0"
          >
            <SelectValue>{() => reasoning || m.agent_form_provider_default()}</SelectValue>
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
    </>
  );
}

function runtimeProvider(value: string): RuntimeProvider {
  if (value === "pi" || value === "codex" || value === "claude-code") return value;
  return "coforge";
}

function providerLabel(provider: RuntimeProvider) {
  if (provider === "coforge") return m.agent_provider_pi_builtin();
  if (provider === "pi") return "Pi";
  if (provider === "codex") return "Codex";
  return "Claude Code";
}

function modelOptionValue(model: CodeAgentModelMetadata) {
  return JSON.stringify([model.modelProvider, model.id]);
}

function runtimeModels(options: RuntimeOptions | undefined, provider: RuntimeProvider) {
  return options?.catalogs.find((item) => item.provider === provider)?.models ?? [];
}

function piCatalogModels(options: RuntimeOptions | undefined) {
  const models = [...runtimeModels(options, "pi"), ...runtimeModels(options, "coforge")];
  const unique = new Map<string, CodeAgentModelMetadata>();
  for (const model of models) {
    const key = modelOptionValue(model);
    if (!unique.has(key)) unique.set(key, model);
  }
  return [...unique.values()];
}
