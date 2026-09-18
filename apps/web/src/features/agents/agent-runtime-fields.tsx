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
import {
  isPiBuiltinModelProvider,
  KEYED_MODEL_PROVIDERS,
  PI_BUILTIN_MODEL_PROVIDERS,
} from "./agent.schemas";
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

/** Pi's two built-in providers are proper nouns, like the RuntimeProvider brand names in
 * `runtime-provider-display.ts`: never localized. */
const PI_BUILTIN_MODEL_PROVIDER_LABELS: Record<string, string> = {
  deepseek: "DeepSeek",
  openrouter: "OpenRouter",
};

/** The Model select's "let the built-in provider/Pi choose" sentinel and the Configured list's
 * "type it in myself" sentinel. Neither collides with a real `modelOptionValue` (which always
 * contains "--"), and both stay free of the CSS-selector-special characters `modelOptionValue`
 * itself has to avoid. */
const CUSTOM_MODEL_KEY = "custom-model";

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
  const [piProviderChoice, setPiProviderChoice] = useState(
    piInitialProviderChoice(initial, credentialConfigured),
  );
  const piExtraProvider = piExtraProviderOption(initial, credentialConfigured);
  const initialModelKey = initial?.model
    ? `${encodeURIComponent(initial.modelProvider ?? "")}--${encodeURIComponent(initial.model)}`
    : "";
  const [modelKey, setModelKey] = useState(initialModelKey);
  const [customModelActive, setCustomModelActive] = useState(false);
  const [customModelText, setCustomModelText] = useState("");
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
  const isPi = provider === RUNTIME_PROVIDER.PI;
  const piConfigured = isPi && piProviderChoice === "";
  const piBuiltin = isPi && !piConfigured;

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

  const configuredModelSelected = Boolean(
    initial?.model && provider === initial.provider && modelKey === initialModelKey,
  );

  // A saved Pi Configured pick whose model the Computer's Pi catalog no longer reports (or never
  // did) opens as Custom, prefilled, rather than silently falling back to "Configured default".
  useEffect(() => {
    if (!options || customModelActive) return;
    if (!(piConfigured && configuredModelSelected)) return;
    if (
      isPiCustomModel(piConfiguredModels(options), initial?.modelProvider, initial?.model ?? "")
    ) {
      setCustomModelActive(true);
      setCustomModelText(joinCustomModel(initial?.modelProvider, initial?.model ?? ""));
    }
  }, [options, piConfigured, configuredModelSelected, initial, customModelActive]);

  const catalogModels = isPi
    ? piBuiltin
      ? piBuiltinModels(options, piProviderChoice)
      : piConfiguredModels(options)
    : runtimeModels(options, provider);
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
  const configuredModelLabel = configuredModelSelected
    ? selectedModel?.displayName || initial?.model
    : undefined;
  const customSplit = customModelActive ? splitCustomModel(customModelText) : undefined;
  const customInvalid = customModelActive && customModelText.trim() !== "" && !customSplit;
  const submittedModelProvider = piBuiltin
    ? piProviderChoice
    : provider === RUNTIME_PROVIDER.COFORGE
      ? modelProvider
      : customModelActive
        ? (customSplit?.modelProvider ?? "")
        : (selectedModel?.modelProvider ??
          (modelKey === initialModelKey ? (initial?.modelProvider ?? "") : ""));
  const matchingConfiguredCredential =
    credentialConfigured &&
    initial?.provider === provider &&
    initial.modelProvider === submittedModelProvider;
  const visibleModels = catalogModels.filter((model) => {
    if (provider === RUNTIME_PROVIDER.COFORGE) return model.modelProvider === modelProvider;
    return true;
  });
  const modelValue = customModelActive
    ? (customSplit?.model ?? "")
    : (selectedModel?.id ?? (modelKey === initialModelKey ? initial?.model : ""));
  const { visible: reasoningVisible, submitted: submittedReasoning } = reasoningFieldState(
    selectedModel,
    reasoning,
  );
  const apiKeyProviderId = piBuiltin ? piProviderChoice : modelProvider;
  const showApiKeyField =
    !RUNTIME_PROVIDER_USES_EXTERNAL_CLI[provider] &&
    (piBuiltin || (provider !== RUNTIME_PROVIDER.PI && KEYED_MODEL_PROVIDERS.has(modelProvider)));
  const dirty = isRuntimeDirty({
    manualDirty,
    apiKey,
    provider,
    submittedModelProvider,
    modelValue: modelValue ?? "",
    submittedReasoning,
    initial,
  });

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  function resetModelFields() {
    setModelKey("");
    setCustomModelActive(false);
    setCustomModelText("");
    setReasoning("");
    setApiKey("");
  }

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
          setPiProviderChoice("");
          resetModelFields();
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
        <input type="hidden" name="modelProvider" value={submittedModelProvider} />
      )}
      {!failed && !RUNTIME_PROVIDER_USES_EXTERNAL_CLI[provider] && (
        <Select
          label={m.agent_form_model_provider()}
          size="sm"
          className="min-w-0"
          isDisabled={!options}
          hint={isPi ? m.agent_form_pi_configured_help() : undefined}
          selectedKey={isPi ? piProviderChoice : modelProvider}
          onSelectionChange={(key) => {
            if (key === null) return;
            const value = String(key);
            if (isPi) setPiProviderChoice(value);
            else setModelProvider(value);
            resetModelFields();
          }}
        >
          {isPi ? (
            <>
              <Select.Item id="" label={m.agent_form_pi_provider_configured()} />
              {PI_BUILTIN_MODEL_PROVIDERS.map((value) => (
                <Select.Item
                  key={value}
                  id={value}
                  label={PI_BUILTIN_MODEL_PROVIDER_LABELS[value]}
                />
              ))}
              {piExtraProvider && (
                <Select.Item key={piExtraProvider} id={piExtraProvider} label={piExtraProvider} />
              )}
            </>
          ) : (
            <>
              <Select.Item id="" label={m.agent_form_provider_default()} />
              {modelProviders.map((value) => (
                <Select.Item key={value} id={value} label={value} />
              ))}
            </>
          )}
        </Select>
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
            selectedKey={piConfigured && customModelActive ? CUSTOM_MODEL_KEY : modelKey}
            onSelectionChange={(key) => {
              if (key === null) return;
              const value = String(key);
              if (piConfigured && value === CUSTOM_MODEL_KEY) {
                setCustomModelActive(true);
                setModelKey("");
                setReasoning("");
                return;
              }
              setCustomModelActive(false);
              setModelKey(value);
              const model = catalogModels.find((item) => modelOptionValue(item) === value);
              if (!isPi) {
                if (model?.modelProvider !== modelProvider) setApiKey("");
                setModelProvider(model?.modelProvider ?? "");
              }
              setReasoning(model?.defaultReasoning ?? "");
            }}
          >
            <Select.Item
              id=""
              label={
                piConfigured
                  ? m.agent_form_model_configured_default()
                  : m.agent_form_provider_default()
              }
            />
            {configuredModelSelected && !selectedModel && !(piConfigured && customModelActive) && (
              <Select.Item id={initialModelKey} label={configuredModelLabel} />
            )}
            {visibleModels.map((model) => (
              <Select.Item
                key={modelOptionValue(model)}
                id={modelOptionValue(model)}
                className="[&_[slot=label]]:whitespace-normal [&_[slot=label]]:wrap-break-word"
                label={piConfigured ? piConfiguredModelLabel(model) : model.displayName}
              />
            ))}
            {piConfigured && (
              <Select.Item id={CUSTOM_MODEL_KEY} label={m.agent_form_model_custom()} />
            )}
          </Select>
        </>
      )}
      {piConfigured && customModelActive && (
        <Input
          label={m.agent_form_model_custom_id()}
          size="sm"
          className="min-w-0 sm:col-span-2"
          placeholder="provider/model-id"
          value={customModelText}
          onChange={setCustomModelText}
          // Native validation blocks the form submit: an empty or slash-less entry would
          // otherwise submit no model and silently save "Configured default".
          isRequired
          validate={(value) => (splitCustomModel(value) ? null : m.agent_form_model_custom_error())}
          isInvalid={customInvalid}
          hint={customInvalid ? m.agent_form_model_custom_error() : undefined}
        />
      )}
      {showApiKeyField && (
        <label className="grid min-w-0 gap-1.5 text-sm sm:col-span-2">
          {m.agent_runtime_api_key({ provider: apiKeyProviderId })}
          <input
            name="apiKey"
            type="password"
            aria-label={m.agent_runtime_api_key({ provider: apiKeyProviderId })}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            required={!matchingConfiguredCredential}
            minLength={8}
            maxLength={4096}
            autoComplete="new-password"
            placeholder={m.agent_runtime_api_key_placeholder({ provider: apiKeyProviderId })}
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
      <input type="hidden" name="reasoning" value={submittedReasoning} />
      {reasoningVisible && (
        <Select
          label={m.agent_form_reasoning()}
          size="sm"
          className="min-w-0 sm:col-span-2"
          selectedKey={reasoning}
          onSelectionChange={(key) => key !== null && setReasoning(String(key))}
        >
          <Select.Item id="" label={m.agent_form_provider_default()} />
          {selectedModel?.reasoningEfforts.map((effort) => (
            <Select.Item key={effort} id={effort} label={effort} />
          ))}
        </Select>
      )}
    </>
  );
}

/**
 * Whether the Reasoning field renders and which value the form submits for it. The field shows
 * only when the selected model is in the loaded catalog and reports at least one reasoning level.
 * A catalog model with no levels submits "" so a saved level it cannot accept is cleared. While the
 * model is not in the catalog (loading, load failed, configured model missing) the saved value is
 * submitted unchanged.
 */
export function reasoningFieldState(
  selectedModel: CodeAgentModelMetadata | undefined,
  reasoning: string,
): { visible: boolean; submitted: string } {
  if (!selectedModel) return { visible: false, submitted: reasoning };
  const visible = selectedModel.reasoningEfforts.length > 0;
  return { visible, submitted: visible ? reasoning : "" };
}

/**
 * Whether the current field values would actually change something a Save submits — the same
 * comparison for every RuntimeProvider (Pi's Configured/built-in split only changes how
 * `submittedModelProvider`/`modelValue` are derived upstream, not this comparison itself).
 */
export function isRuntimeDirty(params: {
  manualDirty: boolean;
  apiKey: string;
  provider: RuntimeProvider;
  submittedModelProvider: string;
  modelValue: string;
  submittedReasoning: string;
  initial?: RuntimeSelection;
}): boolean {
  return (
    params.manualDirty ||
    params.apiKey.trim() !== "" ||
    params.provider !== (params.initial?.provider ?? RUNTIME_PROVIDER.COFORGE) ||
    params.submittedModelProvider !== (params.initial?.modelProvider ?? "") ||
    params.modelValue !== (params.initial?.model ?? "") ||
    params.submittedReasoning !== (params.initial?.reasoning ?? "")
  );
}

/**
 * The Pi "Provider" choice (`""` for Configured, else a built-in slug) a saved Agent's runtime
 * config opens with. A stored credential (`credentialConfigured`) means the saved config used a
 * keyed built-in provider — DeepSeek, OpenRouter, or one CoForge no longer offers by default
 * (e.g. `zai`, see `piExtraProviderOption`). No stored credential means Configured: the
 * Computer's own Pi setup, whatever raw provider slug it launched Pi with.
 */
export function piInitialProviderChoice(
  initial: RuntimeSelection | undefined,
  credentialConfigured: boolean,
): string {
  if (!credentialConfigured || initial?.provider !== RUNTIME_PROVIDER.PI) return "";
  return initial.modelProvider ?? "";
}

/**
 * A saved Pi built-in provider outside `PI_BUILTIN_MODEL_PROVIDERS` (e.g. `zai`, offered before
 * CoForge narrowed the Pi picker to DeepSeek/OpenRouter): still listed as a Provider option so
 * opening and saving the runtime dialog doesn't silently switch the Agent away from it.
 */
export function piExtraProviderOption(
  initial: RuntimeSelection | undefined,
  credentialConfigured: boolean,
): string | undefined {
  const choice = piInitialProviderChoice(initial, credentialConfigured);
  return choice && !isPiBuiltinModelProvider(choice) ? choice : undefined;
}

/** Whether a saved Pi Configured pick (`modelProvider`/`model`) is absent from the Computer's own
 * Pi catalog — it opens the Model field as Custom, prefilled, rather than falling back to
 * "Configured default" and silently changing the Agent's launch config. */
export function isPiCustomModel(
  models: CodeAgentModelMetadata[],
  modelProvider: string | undefined,
  model: string,
): boolean {
  if (!model) return false;
  return !models.some((item) => item.id === model && item.modelProvider === modelProvider);
}

/** The Custom model ID field's prefill for a saved provider/model pair. */
export function joinCustomModel(modelProvider: string | undefined, model: string): string {
  return `${modelProvider ?? ""}/${model}`;
}

/**
 * Splits a "Custom model ID" entry at the FIRST `/` into `modelProvider`/`model` — a model id can
 * itself contain slashes (an OpenRouter id like `anthropic/claude-x`), so only the first one
 * marks the provider boundary. Returns undefined when the text has no `/`, or either side of it
 * is empty.
 */
export function splitCustomModel(
  value: string,
): { modelProvider: string; model: string } | undefined {
  const trimmed = value.trim();
  const index = trimmed.indexOf("/");
  if (index <= 0 || index === trimmed.length - 1) return undefined;
  return { modelProvider: trimmed.slice(0, index), model: trimmed.slice(index + 1) };
}

/** A Pi Configured model's Select label: the catalog only lists this Computer's Pi models across
 * every host-configured provider, so each option names both. */
export function piConfiguredModelLabel(model: CodeAgentModelMetadata): string {
  return `${model.displayName} · ${model.modelProvider}`;
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

/** The models offered by the Pi "Configured" list: exactly the Computer's own Pi catalog
 * (`~/.pi/agent`), never CoForge's keyed-provider catalog — unlike `piBuiltinModels`, which reads
 * that catalog instead once a built-in provider is chosen. */
export function piConfiguredModels(options: RuntimeOptions | undefined) {
  return runtimeModels(options, RUNTIME_PROVIDER.PI);
}

/** The models offered once a Pi built-in provider is selected: CoForge's keyed-provider catalog
 * (the same one the CoForge runtime picker uses), filtered to that one provider. */
export function piBuiltinModels(options: RuntimeOptions | undefined, modelProvider: string) {
  return runtimeModels(options, RUNTIME_PROVIDER.COFORGE).filter(
    (model) => model.modelProvider === modelProvider,
  );
}
