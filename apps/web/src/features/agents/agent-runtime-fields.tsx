import { useEffect, useRef, useState } from "react";
import type { CodeAgentModelMetadata, RuntimeProvider } from "@coforge/protocol";

import { Button } from "@/components/base/buttons/button";
import { Select } from "@/components/base/select/select";
import { m } from "@/paraglide/messages";

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
  onLoad,
}: {
  open: boolean;
  computerId: string;
  initial?: RuntimeSelection;
  onLoad: (computerId: string) => Promise<RuntimeOptions>;
}) {
  const [provider, setProvider] = useState(initial?.provider ?? "coforge");
  const [modelProvider, setModelProvider] = useState(initial?.modelProvider ?? "");
  const initialModelKey = initial?.model
    ? `${encodeURIComponent(initial.modelProvider ?? "")}--${encodeURIComponent(initial.model)}`
    : "";
  const [modelKey, setModelKey] = useState(initialModelKey);
  const [reasoning, setReasoning] = useState(initial?.reasoning ?? "");
  const [optionsByComputer, setOptionsByComputer] = useState<
    Record<string, RuntimeOptions | undefined>
  >({});
  const [failedComputerId, setFailedComputerId] = useState<string>();
  const [retry, setRetry] = useState(0);
  const loading = useRef(new Set<string>());
  const options = optionsByComputer[computerId];
  const failed = failedComputerId === computerId;

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
  const catalog = options?.catalogs.find((item) => item.provider === provider);
  const modelProviders = [
    ...new Set(
      (catalog?.models ?? [])
        .map((model) => model.modelProvider)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const selectedModel = catalog?.models.find(
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

  return (
    <>
      <div className="grid min-w-0 gap-1.5 text-sm">
        <span>{m.agent_form_provider()}</span>
        <input type="hidden" name="provider" value={provider} />
        <Select
          aria-label={m.agent_form_provider()}
          size="sm"
          className="min-w-0"
          selectedKey={provider}
          onSelectionChange={(key) => {
            if (key === null) return;
            setProvider(runtimeProvider(String(key)));
            setModelProvider("");
            setModelKey("");
            setReasoning("");
          }}
        >
          <Select.Item id="coforge" label={m.agent_provider_pi_builtin()} />
          {providers.has("pi") && <Select.Item id="pi" label="Pi" />}
          {providers.has("codex") && <Select.Item id="codex" label="Codex" />}
          {providers.has("claude-code") && <Select.Item id="claude-code" label="Claude Code" />}
        </Select>
      </div>
      {failed ? (
        <label className="grid min-w-0 gap-1.5 text-sm">
          {m.agent_form_model_provider()}
          <input
            name="modelProvider"
            required={provider === "coforge"}
            maxLength={100}
            defaultValue={modelProvider}
            className="h-9 min-w-0 rounded-md border border-secondary bg-primary px-3"
          />
        </label>
      ) : (
        provider === "coforge" && (
          <div className="grid min-w-0 gap-1.5 text-sm">
            <span>{m.agent_form_model_provider()}</span>
            <input type="hidden" name="modelProvider" value={modelProvider} />
            <Select
              aria-label={m.agent_form_model_provider()}
              size="sm"
              className="min-w-0"
              isDisabled={!options}
              selectedKey={modelProvider}
              onSelectionChange={(key) => {
                if (key === null) return;
                setModelProvider(String(key));
                setModelKey("");
                setReasoning("");
              }}
            >
              <Select.Item id="" label={m.agent_form_provider_default()} />
              {modelProviders.map((value) => (
                <Select.Item key={value} id={value} label={value} />
              ))}
            </Select>
          </div>
        )
      )}
      {!failed && provider !== "coforge" && (
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
            className="h-9 min-w-0 rounded-md border border-secondary bg-primary px-3"
          />
        </label>
      ) : (
        <div className="grid min-w-0 gap-1.5 text-sm">
          <span>{m.agent_form_model()}</span>
          <input
            type="hidden"
            name="model"
            value={selectedModel?.id ?? (modelKey === initialModelKey ? initial?.model : "")}
          />
          <Select
            aria-label={`${m.agent_form_model()} ${m.agent_optional()}`}
            size="sm"
            className="min-w-0"
            isDisabled={!options}
            selectedKey={modelKey}
            onSelectionChange={(key) => {
              if (key === null) return;
              const value = String(key);
              setModelKey(value);
              const model = catalog?.models.find((item) => modelOptionValue(item) === value);
              setReasoning(model?.defaultReasoning ?? "");
            }}
          >
            <Select.Item id="" label={m.agent_form_provider_default()} />
            {configuredModelSelected && !selectedModel && (
              <Select.Item id={initialModelKey} label={configuredModelLabel} />
            )}
            {catalog?.models
              .filter((model) => provider !== "coforge" || model.modelProvider === modelProvider)
              .map((model) => (
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
        </div>
      )}
      {failed && (
        <div role="alert" className="grid gap-2 text-sm text-error-primary sm:col-span-2">
          <span>{m.agent_form_catalog_manual_help()}</span>
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
      <div className="grid min-w-0 gap-1.5 text-sm sm:col-span-2">
        <span>{m.agent_form_reasoning()}</span>
        <input type="hidden" name="reasoning" value={reasoning} />
        <Select
          aria-label={`${m.agent_form_reasoning()} ${m.agent_optional()}`}
          size="sm"
          className="min-w-0"
          isDisabled={!selectedModel?.reasoningEfforts.length}
          selectedKey={reasoning}
          onSelectionChange={(key) => key !== null && setReasoning(String(key))}
        >
          <Select.Item id="" label={m.agent_form_provider_default()} />
          {selectedModel?.reasoningEfforts.map((effort) => (
            <Select.Item key={effort} id={effort} label={effort} />
          ))}
        </Select>
      </div>
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
