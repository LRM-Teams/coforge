import { expect, test } from "bun:test";
import { RUNTIME_PROVIDER, type CodeAgentModelMetadata } from "@lrm/coforge-sdk/internal";

import {
  isPiCustomModel,
  isRuntimeDirty,
  joinCustomModel,
  piBuiltinModels,
  piConfiguredModelLabel,
  piConfiguredModels,
  piExtraProviderOption,
  piInitialProviderChoice,
  reasoningFieldState,
  splitCustomModel,
  type RuntimeOptions,
  type RuntimeSelection,
} from "@/features/agents/agent-runtime-fields";

/**
 * `reasoningFieldState` decides whether the Reasoning field should render and what value the
 * form should submit for it. It's tested directly (rather than through a rendered
 * `AgentRuntimeFields`) because the field's visibility depends on a catalog fetched in an
 * effect, which `renderToStaticMarkup` never runs; see `agent-runtime-config-dialog.test.tsx`.
 * The Pi model-picker helpers below are tested the same way, for the same reason.
 */

function model(overrides: Partial<CodeAgentModelMetadata> = {}): CodeAgentModelMetadata {
  return {
    id: "model-1",
    displayName: "Model One",
    description: "",
    modelProvider: "example",
    reasoningEfforts: [],
    defaultReasoning: "",
    recommended: false,
    ...overrides,
  };
}

test("model unknown (no catalog match yet): field hidden, current reasoning submitted unchanged", () => {
  expect(reasoningFieldState(undefined, "medium")).toEqual({
    visible: false,
    submitted: "medium",
  });
});

test("model known with no reasoning levels: field hidden, submitted reasoning forced to empty", () => {
  const known = model({ reasoningEfforts: [] });
  expect(reasoningFieldState(known, "medium")).toEqual({
    visible: false,
    submitted: "",
  });
});

test("model known with reasoning levels: field shown, current reasoning submitted as-is", () => {
  const known = model({ reasoningEfforts: ["low", "medium", "high"] });
  expect(reasoningFieldState(known, "high")).toEqual({
    visible: true,
    submitted: "high",
  });
});

const piModel = model({
  id: "deepseek-v4",
  displayName: "DeepSeek V4",
  modelProvider: "lenovo-deepseek-v4",
});
const coforgeModel = model({
  id: "deepseek-chat",
  displayName: "DeepSeek Chat",
  modelProvider: "deepseek",
});
const options: RuntimeOptions = {
  providers: ["pi"],
  catalogs: [
    { provider: RUNTIME_PROVIDER.PI, models: [piModel] },
    { provider: RUNTIME_PROVIDER.COFORGE, models: [coforgeModel] },
  ],
};

test("Configured lists only the Pi catalog, never the CoForge keyed-provider catalog", () => {
  const models = piConfiguredModels(options);
  expect(models).toEqual([piModel]);
  expect(models.some((item) => item.modelProvider === "deepseek")).toBe(false);
});

test("Configured model labels combine the display name and the raw provider slug", () => {
  expect(piConfiguredModelLabel(piModel)).toBe("DeepSeek V4 · Lenovo DeepSeek V4");
});

test("a built-in provider lists only the CoForge catalog, filtered to that provider", () => {
  expect(piBuiltinModels(options, "deepseek")).toEqual([coforgeModel]);
  expect(piBuiltinModels(options, "openrouter")).toEqual([]);
  expect(piBuiltinModels(options, "deepseek").some((item) => item.id === piModel.id)).toBe(false);
});

test("splitCustomModel splits at the first slash, keeping later slashes in the model id", () => {
  expect(splitCustomModel("openrouter/anthropic/claude-x")).toEqual({
    modelProvider: "openrouter",
    model: "anthropic/claude-x",
  });
});

test("splitCustomModel rejects text with no slash or an empty side", () => {
  expect(splitCustomModel("deepseek-chat")).toBeUndefined();
  expect(splitCustomModel("/deepseek-chat")).toBeUndefined();
  expect(splitCustomModel("deepseek/")).toBeUndefined();
  expect(splitCustomModel("")).toBeUndefined();
});

test("joinCustomModel formats a saved provider/model pair for the Custom field", () => {
  expect(joinCustomModel("lenovo-deepseek-v4", "deepseek-v4")).toBe(
    "lenovo-deepseek-v4/deepseek-v4",
  );
});

test("isPiCustomModel: absent from the Pi catalog is custom, present is not", () => {
  expect(isPiCustomModel([piModel], "lenovo-deepseek-v4", "deepseek-v4")).toBe(false);
  expect(isPiCustomModel([piModel], "cc-club", "some-other-model")).toBe(true);
  expect(isPiCustomModel([piModel], "lenovo-deepseek-v4", "")).toBe(false);
});

const piInitial: RuntimeSelection = {
  provider: RUNTIME_PROVIDER.PI,
  modelProvider: "lenovo-deepseek-v4",
  model: "deepseek-v4",
  reasoning: "",
};

test("no stored credential: the saved Pi config opens as Configured", () => {
  expect(piInitialProviderChoice(piInitial, false)).toBe("");
});

test("a stored credential for a Pi built-in provider opens the Provider picker on it", () => {
  expect(piInitialProviderChoice({ ...piInitial, modelProvider: "deepseek" }, true)).toBe(
    "deepseek",
  );
});

test("a stored credential for a provider outside the built-in set is offered as an extra option", () => {
  const zaiInitial = { ...piInitial, modelProvider: "zai" };
  expect(piInitialProviderChoice(zaiInitial, true)).toBe("zai");
  expect(piExtraProviderOption(zaiInitial, true)).toBe("zai");
});

test("a stored credential for a built-in provider is not offered as an extra option", () => {
  const deepseekInitial = { ...piInitial, modelProvider: "deepseek" };
  expect(piExtraProviderOption(deepseekInitial, true)).toBeUndefined();
});

test("Configured (no credential) never offers an extra Provider option", () => {
  expect(piExtraProviderOption(piInitial, false)).toBeUndefined();
});

/**
 * `isRuntimeDirty` composed with the same Pi helpers `AgentRuntimeFields` derives its field
 * values from, mirroring exactly what each field would compute for a saved Pi config the dialog
 * has just opened with — the three ways it must open as not-dirty (nothing submitted yet).
 */
test("opens not-dirty: a saved Configured model found in the Pi catalog", () => {
  const initial: RuntimeSelection = {
    provider: RUNTIME_PROVIDER.PI,
    modelProvider: piModel.modelProvider,
    model: piModel.id,
    reasoning: "",
  };
  expect(isPiCustomModel(piConfiguredModels(options), initial.modelProvider, initial.model)).toBe(
    false,
  );
  expect(
    isRuntimeDirty({
      manualDirty: false,
      apiKey: "",
      provider: RUNTIME_PROVIDER.PI,
      submittedModelProvider: piModel.modelProvider,
      modelValue: piModel.id,
      submittedReasoning: "",
      initial,
    }),
  ).toBe(false);
});

test("opens not-dirty: a saved built-in provider with a stored credential", () => {
  const initial: RuntimeSelection = {
    provider: RUNTIME_PROVIDER.PI,
    modelProvider: coforgeModel.modelProvider,
    model: coforgeModel.id,
    reasoning: "",
  };
  const piProviderChoice = piInitialProviderChoice(initial, true);
  expect(piProviderChoice).toBe(coforgeModel.modelProvider);
  expect(piBuiltinModels(options, piProviderChoice)).toEqual([coforgeModel]);
  expect(
    isRuntimeDirty({
      manualDirty: false,
      apiKey: "",
      provider: RUNTIME_PROVIDER.PI,
      submittedModelProvider: piProviderChoice,
      modelValue: coforgeModel.id,
      submittedReasoning: "",
      initial,
    }),
  ).toBe(false);
});

test("opens not-dirty: a saved custom model absent from the Pi catalog preselects Custom", () => {
  const initial: RuntimeSelection = {
    provider: RUNTIME_PROVIDER.PI,
    modelProvider: "cc-club",
    model: "custom-model-xyz",
    reasoning: "",
  };
  expect(isPiCustomModel(piConfiguredModels(options), initial.modelProvider, initial.model)).toBe(
    true,
  );
  const prefilled = joinCustomModel(initial.modelProvider, initial.model);
  expect(prefilled).toBe("cc-club/custom-model-xyz");
  const split = splitCustomModel(prefilled);
  expect(split).toEqual({ modelProvider: "cc-club", model: "custom-model-xyz" });
  expect(
    isRuntimeDirty({
      manualDirty: false,
      apiKey: "",
      provider: RUNTIME_PROVIDER.PI,
      submittedModelProvider: split?.modelProvider ?? "",
      modelValue: split?.model ?? "",
      submittedReasoning: "",
      initial,
    }),
  ).toBe(false);
});
