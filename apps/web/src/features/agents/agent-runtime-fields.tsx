import { useEffect, useRef, useState } from "react";
import {
  parseRuntimeProvider,
  RUNTIME_PROVIDER,
  RUNTIME_PROVIDER_USES_EXTERNAL_CLI,
  type CodeAgentModelMetadata,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";

import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { m } from "@/paraglide/messages";
import { KEYED_MODEL_PROVIDERS } from "./agent.schemas";
import { RUNTIME_PROVIDER_DISPLAY_ORDER, runtimeProviderLabel } from "./runtime-provider-display";
import { RuntimeProviderMark } from "./runtime-provider-mark";

export type RuntimeCatalog = {
  provider: string;
  models: CodeAgentModelMetadata[];
};
export type RuntimeOptions = {
  providers: string[];
  catalogs: RuntimeCatalog[];
};

export type RuntimeSelection = {
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
  onDirtyChange,
}: {
  open: boolean;
  computerId: string;
  initial?: RuntimeSelection;
  credentialConfigured?: boolean;
  onLoad: (computerId: string) => Promise<RuntimeOptions>;
  /** Fires with the current "would this Save do anything" state whenever a field the user can
   * actually change moves away from (or back to) `initial`. `AgentRuntimeFields` keeps owning
   * every field's state; this is only a notification, not a hook for the caller to drive values
   * (the Profile panel's edit dialog uses it to disable Save until something changed). */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [provider, setProvider] = useState(initial?.provider ?? RUNTIME_PROVIDER.COFORGE);
  const [modelProvider, setModelProvider] = useState(initial?.modelProvider ?? "");
  const initialModelKey = initial?.model
    ? `${encodeURIComponent(initial.modelProvider ?? "")}--${encodeURIComponent(initial.model)}`
    : "";
  const [modelKey, setModelKey] = useState(initialModelKey);
  const [reasoning, setReasoning] = useState(initial?.reasoning ?? "");
  const [apiKey, setApiKey] = useState("");
  // Only the catalog-load-failed fallback below renders plain, uncontrolled text `Input`s for
  // modelProvider/model instead of the tracked `Select`s; their own `onChange` marks this so
  // `dirty` still notices a manual edit in that fallback.
  const [manualDirty, setManualDirty] = useState(false);
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

  const providers = new Set([
    RUNTIME_PROVIDER.COFORGE,
    initial?.provider,
    ...(options?.providers ?? []),
  ]);
  const catalogModels =
    provider === RUNTIME_PROVIDER.PI ? piCatalogModels(options) : runtimeModels(options, provider);
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
      (provider !== RUNTIME_PROVIDER.COFORGE || model.modelProvider === modelProvider),
  );
  const configuredModelSelected = Boolean(
    initial?.model && provider === initial.provider && modelKey === initialModelKey,
  );
  const configuredModelLabel = configuredModelSelected
    ? selectedModel?.displayName || initial?.model
    : undefined;
  const submittedModelProvider =
    provider === RUNTIME_PROVIDER.COFORGE
      ? modelProvider
      : (selectedModel?.modelProvider ??
        (modelKey === initialModelKey ? (initial?.modelProvider ?? "") : ""));
  const matchingConfiguredCredential =
    credentialConfigured &&
    initial?.provider === provider &&
    initial.modelProvider === modelProvider;
  const visibleModels = catalogModels.filter((model) => {
    if (provider === RUNTIME_PROVIDER.COFORGE) return model.modelProvider === modelProvider;
    if (provider === RUNTIME_PROVIDER.PI && modelProvider)
      return model.modelProvider === modelProvider;
    return true;
  });
  const modelValue = selectedModel?.id ?? (modelKey === initialModelKey ? initial?.model : "");
  const dirty =
    manualDirty ||
    apiKey.trim() !== "" ||
    provider !== (initial?.provider ?? RUNTIME_PROVIDER.COFORGE) ||
    submittedModelProvider !== (initial?.modelProvider ?? "") ||
    (modelValue ?? "") !== (initial?.model ?? "") ||
    reasoning !== (initial?.reasoning ?? "");

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

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
          setProvider(parseRuntimeProvider(key) ?? RUNTIME_PROVIDER.COFORGE);
          setModelProvider("");
          setModelKey("");
          setReasoning("");
          setApiKey("");
        }}
      >
        <Select.Item
          id={RUNTIME_PROVIDER.COFORGE}
          label={runtimeProviderLabel(RUNTIME_PROVIDER.COFORGE)}
          icon={<RuntimeProviderMark provider={RUNTIME_PROVIDER.COFORGE} />}
        />
        {RUNTIME_PROVIDER_DISPLAY_ORDER.filter((candidate) => providers.has(candidate)).map(
          (candidate) => (
            <Select.Item
              key={candidate}
              id={candidate}
              label={runtimeProviderLabel(candidate)}
              icon={<RuntimeProviderMark provider={candidate} />}
            />
          ),
        )}
      </Select>
      {failed ? (
        <Input
          label={m.agent_form_model_provider()}
          name="modelProvider"
          size="sm"
          isRequired={provider === RUNTIME_PROVIDER.COFORGE}
          maxLength={100}
          defaultValue={modelProvider}
          onChange={() => {
            setApiKey("");
            setManualDirty(true);
          }}
        />
      ) : (
        !RUNTIME_PROVIDER_USES_EXTERNAL_CLI[provider] && (
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
      {!failed && RUNTIME_PROVIDER_USES_EXTERNAL_CLI[provider] && (
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
          className="min-w-0 sm:col-span-2"
          onChange={() => setManualDirty(true)}
        />
      ) : (
        <>
          <input type="hidden" name="model" value={modelValue} />
          <Select
            label={m.agent_form_model()}
            size="sm"
            wrapValue
            className="min-w-0 sm:col-span-2"
            popoverClassName="min-w-(--trigger-width) w-max max-w-[min(36rem,calc(100vw-3rem))]"
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
                className="[&_[slot=label]]:whitespace-normal [&_[slot=label]]:wrap-break-word"
                label={
                  provider === "pi" && !modelProvider && model.modelProvider
                    ? `${model.modelProvider} / ${model.displayName}`
                    : model.displayName
                }
              />
            ))}
          </Select>
        </>
      )}
      {!RUNTIME_PROVIDER_USES_EXTERNAL_CLI[provider] &&
        KEYED_MODEL_PROVIDERS.has(modelProvider) && (
          <label className="grid min-w-0 gap-1.5 text-sm sm:col-span-2">
            {m.agent_runtime_api_key({ provider: modelProvider })}
            <input
              name="apiKey"
              type="password"
              aria-label={m.agent_runtime_api_key({ provider: modelProvider })}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              required={provider === RUNTIME_PROVIDER.COFORGE && !matchingConfiguredCredential}
              minLength={8}
              maxLength={4096}
              autoComplete="new-password"
              placeholder={m.agent_runtime_api_key_placeholder({ provider: modelProvider })}
              className="h-10 rounded-lg border border-secondary bg-primary px-3 shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-brand"
            />
            <span className="text-xs font-normal text-tertiary">
              {matchingConfiguredCredential
                ? m.agent_form_api_key_preserve_help()
                : provider === RUNTIME_PROVIDER.PI
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
  const models = [
    ...runtimeModels(options, RUNTIME_PROVIDER.PI),
    ...runtimeModels(options, RUNTIME_PROVIDER.COFORGE),
  ];
  const unique = new Map<string, CodeAgentModelMetadata>();
  for (const model of models) {
    const key = modelOptionValue(model);
    if (!unique.has(key)) unique.set(key, model);
  }
  return [...unique.values()];
}
