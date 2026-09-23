import { useCallback, useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { RefreshCw01 } from "@untitledui/icons";
import {
  parseRuntimeProvider,
  RUNTIME_PROVIDER,
  RUNTIME_PROVIDER_USES_EXTERNAL_CLI,
  type CodeAgentModelMetadata,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";

import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import {
  getComputerRuntimeCatalog,
  refreshComputerRuntimeCatalog,
} from "@/features/computers/computers.functions";
import { m } from "@/paraglide/messages";
import {
  isPiBuiltinModelProvider,
  KEYED_MODEL_PROVIDERS,
  PI_BUILTIN_MODEL_PROVIDERS,
} from "./agent.schemas";
import { modelProviderDisplayName } from "./model-provider-display";
import { RUNTIME_PROVIDER_DISPLAY_ORDER, runtimeProviderLabel } from "./runtime-provider-display";
import { RuntimeProviderMark } from "./runtime-provider-mark";

export type RuntimeCatalog = {
  provider: string;
  models: CodeAgentModelMetadata[];
  /** When the Daemon reported this catalog; set by `getComputerRuntimeCatalog`. A refresh watch
   * uses it to detect a newer report from the Computer. */
  observedAt?: string | Date;
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

/** The Model select's "let the built-in provider/Pi choose" sentinel and the Configured list's
 * "type it in myself" sentinel. Neither collides with a real `modelOptionValue` (which always
 * contains "--"), and both stay free of the CSS-selector-special characters `modelOptionValue`
 * itself has to avoid. */
const CUSTOM_MODEL_KEY = "custom-model";

/** Opening the Model select re-reads the catalog at most once per interval: a refresh asks the
 * Computer's daemon to re-discover (which spawns a provider CLI probe), which is not free, and
 * quickly closing and reopening the select should not stack requests. The cache from the previous
 * load stays rendered until a refresh returns, so an open never blocks on the network. */
const MODEL_CATALOG_AUTO_REFRESH_INTERVAL_MS = 30_000;
/** How long a click/auto refresh waits for the Computer's re-report before giving up and keeping
 * the cached catalog: discovery spawns provider CLIs, so it can take several seconds. */
const MODEL_CATALOG_REFRESH_TIMEOUT_MS = 20_000;
const MODEL_CATALOG_REFRESH_POLL_MS = 1_500;

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
  const autoRefreshedAt = useRef(0);
  const [refreshing, setRefreshing] = useState(false);
  const requestRefresh = useServerFn(refreshComputerRuntimeCatalog);
  const loadCatalog = useServerFn(getComputerRuntimeCatalog);
  const options = optionsByComputer[computerId];
  const failed = failedComputerId === computerId;
  const isPi = provider === RUNTIME_PROVIDER.PI;
  const piConfigured = isPi && piProviderChoice === "";
  const piBuiltin = isPi && !piConfigured;

  /** Asks the Computer's daemon to re-run its model-catalog discovery (the
   * `daemon:v1:provider:model_refresh` wire), then polls `getComputerRuntimeCatalog` until its
   * `observedAt` moves past the pre-refresh snapshot — the daemon re-reports through the ordinary
   * inventory update before answering. The previously loaded catalog stays rendered throughout
   * (cache fallback): a refresh never blanks the selects, and a timeout — an offline or
   * pre-upgrade daemon that cannot answer — keeps the last known list. */
  const refreshCatalog = useCallback(
    (throttle: boolean) => {
      if (!open || !computerId || refreshing || loading.current.has(computerId)) return;
      const now = Date.now();
      if (throttle && now - autoRefreshedAt.current < MODEL_CATALOG_AUTO_REFRESH_INTERVAL_MS)
        return;
      autoRefreshedAt.current = now;
      setRefreshing(true);
      void (async () => {
        const previousCatalogs = optionsByComputer[computerId]?.catalogs;
        const baseline = maxCatalogObservedAt(previousCatalogs);
        try {
          await requestRefresh({ data: { computerId } });
        } catch {
          // The daemon may be offline or pre-upgrade; the poll below still re-reads the stored
          // catalog once and keeps the cache when nothing moved.
        }
        const deadline = Date.now() + MODEL_CATALOG_REFRESH_TIMEOUT_MS;
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, MODEL_CATALOG_REFRESH_POLL_MS));
          let loaded;
          try {
            loaded = await loadCatalog({ data: { computerId } });
          } catch {
            break; // Cache fallback: keep the last loaded catalog.
          }
          if (maxCatalogObservedAt(loaded) > baseline) {
            setOptionsByComputer((current) => ({
              ...current,
              [computerId]: { providers: current[computerId]?.providers ?? [], catalogs: loaded },
            }));
            return;
          }
        }
      })().finally(() => setRefreshing(false));
    },
    [computerId, loadCatalog, open, optionsByComputer, refreshing, requestRefresh],
  );

  useEffect(() => {
    if (!open) setApiKey("");
  }, [open]);

  useEffect(() => {
    if (previousComputerId.current !== computerId) {
      setApiKey("");
      autoRefreshedAt.current = 0;
    }
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
          // The Pi provider picker carries no hint: the sentence that used to sit here explained
          // Configured by contrast with the key-passing choices, which the picker and the API-key
          // field already say on their own.
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
                <Select.Item key={value} id={value} label={modelProviderDisplayName(value)} />
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
          <div className="relative min-w-0 sm:col-span-2">
            <Select
              label={m.agent_form_model()}
              size="sm"
              wrapValue
              className="min-w-0 [&_[data-label]]:pr-8"
              popoverClassName="min-w-(--trigger-width) w-max max-w-[min(36rem,calc(100vw-3rem))]"
              isDisabled={!options}
              selectedKey={piConfigured && customModelActive ? CUSTOM_MODEL_KEY : modelKey}
              onOpenChange={(isOpen) => {
                if (isOpen) refreshCatalog(true);
              }}
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
                    ? m.agent_form_pi_provider_configured()
                    : m.agent_form_provider_default()
                }
              />
              {configuredModelSelected &&
                !selectedModel &&
                !(piConfigured && customModelActive) && (
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
            <div className="absolute top-0 right-0 flex h-5 items-center">
              <ButtonUtility
                icon={RefreshCw01}
                size="xs"
                color="tertiary"
                tooltip={m.agent_form_model_refresh()}
                onClick={() => refreshCatalog(false)}
                className={refreshing ? "*:data-icon:animate-spin" : undefined}
              />
            </div>
          </div>
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
        <Input
          label={m.agent_runtime_api_key({ provider: apiKeyProviderId })}
          size="sm"
          className="min-w-0 sm:col-span-2"
          name="apiKey"
          type="password"
          value={apiKey}
          onChange={setApiKey}
          isRequired={!matchingConfiguredCredential}
          minLength={8}
          maxLength={4096}
          autoComplete="new-password"
          placeholder={m.agent_runtime_api_key_placeholder({ provider: apiKeyProviderId })}
          hint={
            matchingConfiguredCredential
              ? m.agent_form_api_key_preserve_help()
              : provider === RUNTIME_PROVIDER.PI
                ? m.agent_form_pi_api_key_help()
                : m.agent_form_coforge_api_key_help()
          }
        />
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
  return `${model.displayName} · ${modelProviderDisplayName(model.modelProvider)}`;
}

/** The newest report time across a catalog list: how a refresh decides the Computer's re-report
 * has landed (the daemon re-reports with a fresh `observedAt` even when the models did not
 * change). Serialization across the server-fn boundary may deliver a Date or an ISO string. */
function maxCatalogObservedAt(catalogs: RuntimeCatalog[] | undefined): number {
  if (!catalogs) return 0;
  return catalogs.reduce((max, catalog) => {
    const value = catalog.observedAt;
    if (!value) return max;
    const time = value instanceof Date ? value.getTime() : Date.parse(value);
    return Number.isFinite(time) ? Math.max(max, time) : max;
  }, 0);
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
