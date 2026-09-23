import { expect, test } from "bun:test";
import { launchCategoryText, launchFailureTrace } from "#src/agent-runtime/launch-failure";

test("launchFailureTrace extracts classified launch evidence from a PiLaunchError", () => {
  const error = {
    name: "PiLaunchError",
    policyCode: "PI_LAUNCH_MODEL_MISSING",
    trace: {
      provider: "ollama-cloud",
      providerPresent: true,
      providerKeyPresent: true,
      baseUrlPresent: true,
      modelPresent: false,
    },
  };
  expect(launchFailureTrace(error)).toEqual({
    launchCategory: "PI_LAUNCH_MODEL_MISSING",
    provider: "ollama-cloud",
    providerPresent: true,
    providerKeyPresent: true,
    baseUrlPresent: true,
    modelPresent: false,
  });
});

test("launchFailureTrace is empty for errors without classification evidence", () => {
  expect(launchFailureTrace(new Error("boom"))).toEqual({});
  expect(launchFailureTrace(null)).toEqual({});
  expect(launchFailureTrace("string")).toEqual({});
  expect(launchFailureTrace({ policyCode: null })).toEqual({});
});

test("launchFailureTrace keeps only exactly-typed members", () => {
  expect(
    launchFailureTrace({
      policyCode: 42,
      trace: { provider: "x", providerPresent: "yes" },
    }),
  ).toMatchObject({ provider: "x" });
  // non-string policyCode is dropped; non-boolean booleans collapse to undefined
  expect(
    launchFailureTrace({
      policyCode: 42,
      trace: { provider: "x", providerPresent: "yes" },
    }).launchCategory,
  ).toBeUndefined();
});

test("launchCategoryText maps policy codes to safe human phrases", () => {
  expect(launchCategoryText("PI_LAUNCH_TIMEOUT")).toBe("model provider refresh timed out");
  expect(launchCategoryText("PI_LAUNCH_PROVIDER_MISSING")).toBe(
    "model provider is not configured in the local model catalog",
  );
  expect(launchCategoryText("PI_LAUNCH_PROVIDER_UNCONFIGURED")).toBe(
    "model provider has no configured credentials",
  );
  expect(launchCategoryText("PI_LAUNCH_MODEL_MISSING")).toBe(
    "the selected model is not available in the local model catalog",
  );
  expect(launchCategoryText("PI_LAUNCH_SPAWN_FAILED")).toBe("the model runtime failed to start");
  expect(launchCategoryText(undefined)).toBeUndefined();
  expect(launchCategoryText("UNKNOWN")).toBeUndefined();
});
