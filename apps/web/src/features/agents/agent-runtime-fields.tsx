import { useEffect, useRef, useState } from "react";
import type { CodeAgentModelMetadata, RuntimeProvider } from "@coforge/protocol";

import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
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
    ? `${encodeURIComponent(initial.modelProvider ?? "")}--${encodeURIComponent(initial.model)}`
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
      <input type="hidden" name="provider" value={provider} />
      <Select
        label={m.agent_form_provider()}
        size="sm"
        className="min-w-0"
        selectedKey={provider}
        onSelectionChange={(key) => {
          if (key === null) return;
          setProvider(runtimeProvider(String(key)));
          setModelProvider("");
          setModelKey("");
          setReasoning("");
          setApiKey("");
        }}
      >
        <Select.Item id="coforge" label={m.agent_provider_pi_builtin()} />
        {providers.has("pi") && <Select.Item id="pi" label="Pi" />}
        {providers.has("codex") && <Select.Item id="codex" label="Codex" />}
        {providers.has("claude-code") && <Select.Item id="claude-code" label="Claude Code" />}
      </Select>
      {failed ? (
        <Input
          label={m.agent_form_model_provider()}
          name="modelProvider"
          size="sm"
          isRequired={provider === "coforge"}
          maxLength={100}
          defaultValue={modelProvider}
          onChange={() => setApiKey("")}
        />
      ) : (
        (provider === "coforge" || provider === "pi") && (
          <>
            <input type="hidden" name="modelProvider" value={modelProvider} />
            <Select
              label={m.agent_form_model_provider()}
              size="sm"
              className="min-w-0"
              isDisabled={!options}
              selectedKey={modelProvider}
              onSelectionChange={(key) => {
                if (key === null) return;
                setModelProvider(String(key));
                setModelKey("");
                setReasoning("");
                setApiKey("");
              }}
            >
              <Select.Item id="" label={m.agent_form_provider_default()} />
              {modelProviders.map((value) => (
                <Select.Item key={value} id={value} label={value} />
              ))}
            </Select>
          </>
        )
      )}
      {!failed && provider !== "coforge" && provider !== "pi" && (
        <input type="hidden" name="modelProvider" value={submittedModelProvider} />
      )}
      {failed ? (
        <Input
          label={m.agent_form_model()}
          name="model"
          size="sm"
          isRequired
          maxLength={200}
          defaultValue={initial?.model}
        />
      ) : (
        <>
          <input
            type="hidden"
            name="model"
            value={selectedModel?.id ?? (modelKey === initialModelKey ? initial?.model : "")}
          />
          <Select
            label={m.agent_form_model()}
            size="sm"
            className="min-w-0"
            isDisabled={!options}
            selectedKey={modelKey}
            onSelectionChange={(key) => {
              if (key === null) return;
              const value = String(key);
              setModelKey(value);
              const model = catalogModels.find((item) => modelOptionValue(item) === value);
              if (model?.modelProvider !== modelProvider) setApiKey("");
              setModelProvider(model?.modelProvider ?? "");
              setReasoning(model?.defaultReasoning ?? "");
            }}
          >
            <Select.Item id="" label={m.agent_form_provider_default()} />
            {configuredModelSelected && !selectedModel && (
              <Select.Item id={initialModelKey} label={configuredModelLabel} />
            )}
            {visibleModels.map((model) => (
              <Select.Item
                key={modelOptionValue(model)}
                id={modelOptionValue(model)}
                label={
                  model.modelProvider
                    ? `${model.modelProvider} / ${model.displayName}`
                    : model.displayName
                }
              />
            ))}
          </Select>
        </>
      )}
      {(provider === "coforge" || provider === "pi") &&
        KEYED_MODEL_PROVIDERS.has(modelProvider) && (
          <label className="grid min-w-0 gap-1.5 text-sm sm:col-span-2">
            {m.agent_runtime_api_key({ provider: modelProvider })}
            <input
              name="apiKey"
              type="password"
              aria-label={m.agent_runtime_api_key({ provider: modelProvider })}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              required={provider === "coforge" && !matchingConfiguredCredential}
              minLength={8}
              maxLength={4096}
              autoComplete="new-password"
              placeholder={m.agent_runtime_api_key_placeholder({ provider: modelProvider })}
              className="h-10 rounded-lg border border-secondary bg-primary px-3 shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-brand"
            />
            <span className="text-xs font-normal text-tertiary">
              {matchingConfiguredCredential
                ? m.agent_form_api_key_preserve_help()
                : provider === "pi"
                  ? m.agent_form_pi_api_key_help()
                  : m.agent_form_coforge_api_key_help()}
            </span>
          </label>
        )}
      {failed && (
        <div role="alert" className="grid gap-2 sm:col-span-2">
          <p className="text-sm text-error-primary">{m.agent_form_catalog_manual_help()}</p>
          <Button
            type="button"
            color="secondary"
            size="sm"
            className="justify-self-start"
            onPress={() => {
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
      <input type="hidden" name="reasoning" value={reasoning} />
      <Select
        label={m.agent_form_reasoning()}
        size="sm"
        className="min-w-0 sm:col-span-2"
        isDisabled={!selectedModel?.reasoningEfforts.length}
        selectedKey={reasoning}
        onSelectionChange={(key) => key !== null && setReasoning(String(key))}
      >
        <Select.Item id="" label={m.agent_form_provider_default()} />
        {selectedModel?.reasoningEfforts.map((effort) => (
          <Select.Item key={effort} id={effort} label={effort} />
        ))}
      </Select>
    </>
  );
}

function runtimeProvider(value: string): RuntimeProvider {
  if (value === "pi" || value === "codex" || value === "claude-code") return value;
  return "coforge";
}

function modelOptionValue(model: CodeAgentModelMetadata) {
  // Used as both a React `key` and a Select.Item `id`. The official Select
  // (react-aria-components) uses the raw id in an internal CSS selector for
  // its collection, so it must stay free of CSS-selector special characters
  // (JSON.stringify's brackets/quotes/commas broke that). Only ever compared
  // for equality here, never parsed back apart, so any collision-free,
  // selector-safe encoding works.
  return `${encodeURIComponent(model.modelProvider)}--${encodeURIComponent(model.id)}`;
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
