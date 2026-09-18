import { expect, test } from "bun:test";
import type { CodeAgentModelMetadata } from "@lrm/coforge-sdk/internal";

import { reasoningFieldState } from "@/features/agents/agent-runtime-fields";

/**
 * `reasoningFieldState` decides whether the Reasoning field should render and what value the
 * form should submit for it. It's tested directly (rather than through a rendered
 * `AgentRuntimeFields`) because the field's visibility depends on a catalog fetched in an
 * effect, which `renderToStaticMarkup` never runs; see `agent-runtime-config-dialog.test.tsx`.
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
