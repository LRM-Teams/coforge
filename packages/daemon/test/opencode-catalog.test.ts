import { expect, test } from "bun:test";

import {
  discoverOpenCodeCatalog,
  parseOpenCodeModelList,
} from "../src/code-agent/opencode/catalog";

const FIXTURE = new URL("./fixtures/opencode-fixture.ts", import.meta.url).pathname;

/** A trimmed real capture of `opencode models --verbose` (2026-09-21, opencode 1.2.24 on s144). */
const VERBOSE_OUTPUT = `opencode/big-pickle
{
  "id": "big-pickle",
  "providerID": "opencode",
  "name": "Big Pickle",
  "limit": { "context": 200000, "input": 160000, "output": 32000 },
  "capabilities": { "reasoning": true },
  "variants": {
    "low": { "reasoningEffort": "low" },
    "medium": { "reasoningEffort": "medium" },
    "high": { "reasoningEffort": "high" }
  }
}
lenovo-deepseek-v4/DeepSeek-V4-Flash-0731
{
  "id": "DeepSeek-V4-Flash-0731",
  "providerID": "lenovo-deepseek-v4",
  "name": "DeepSeek V4 Flash",
  "capabilities": { "reasoning": false }
}
`;

test("parses models verbatim with their variant-derived reasoning levels", () => {
  const models = parseOpenCodeModelList(VERBOSE_OUTPUT);
  expect(models).toHaveLength(2);
  expect(models[0]).toEqual({
    id: "opencode/big-pickle",
    displayName: "Big Pickle",
    description: "",
    modelProvider: "opencode",
    reasoningEfforts: ["low", "medium", "high"],
    defaultReasoning: "",
    recommended: false,
  });
  // A model with no reasoning variant keeps its id as the display name and advertises no levels.
  expect(models[1]).toEqual({
    id: "lenovo-deepseek-v4/DeepSeek-V4-Flash-0731",
    displayName: "DeepSeek V4 Flash",
    description: "",
    modelProvider: "lenovo-deepseek-v4",
    reasoningEfforts: [],
    defaultReasoning: "",
    recommended: false,
  });
});

test("non-verbose output yields the same ids with no reasoning levels", () => {
  expect(parseOpenCodeModelList("opencode/big-pickle\naiberm/gpt-5.6-luna\n")).toEqual([
    {
      id: "opencode/big-pickle",
      displayName: "opencode/big-pickle",
      description: "",
      modelProvider: "opencode",
      reasoningEfforts: [],
      defaultReasoning: "",
      recommended: false,
    },
    {
      id: "aiberm/gpt-5.6-luna",
      displayName: "aiberm/gpt-5.6-luna",
      description: "",
      modelProvider: "aiberm",
      reasoningEfforts: [],
      defaultReasoning: "",
      recommended: false,
    },
  ]);
});

test("orders levels by OpenCode's own effort order, and drops disabled variants", () => {
  const models = parseOpenCodeModelList(`opencode/x
{
  "name": "X",
  "capabilities": { "reasoning": true },
  "variants": {
    "max": { "reasoningEffort": "max" },
    "high": { "reasoningEffort": "high" },
    "minimal": { "reasoningEffort": "minimal" },
    "experimental": { "disabled": true },
    "ultra": { "reasoningEffort": "ultra" }
  }
}
`);
  // Known efforts first in Raft's order (minimal < high < max), then the unknown one alphabetically.
  expect(models[0]?.reasoningEfforts).toEqual(["minimal", "high", "max", "ultra"]);
});

test("a variant map that carries no recognizable reasoning never becomes a picker", () => {
  const models = parseOpenCodeModelList(`opencode/y
{
  "name": "Y",
  "capabilities": { "reasoning": false },
  "variants": { "preview": { "notes": "not an effort" } }
}
`);
  expect(models[0]?.reasoningEfforts).toEqual([]);
});

test("a model row with no metadata block still parses", () => {
  const models = parseOpenCodeModelList('opencode/only-id\n{ "broken": \n');
  expect(models).toHaveLength(1);
  expect(models[0]?.id).toBe("opencode/only-id");
  expect(models[0]?.displayName).toBe("opencode/only-id");
});

test("ignores headers, blank lines and anything that is not a provider/model row", () => {
  const models = parseOpenCodeModelList("\nAvailable models\n\nsome prose line\n\nopencode/a\n");
  expect(models.map((model) => model.id)).toEqual(["opencode/a"]);
});

test("discoverOpenCodeCatalog parses a live `opencode models --verbose` process", async () => {
  const catalog = await discoverOpenCodeCatalog(
    [process.execPath, FIXTURE, "models"],
    process.cwd(),
    { PATH: process.env.PATH, HOME: process.env.HOME },
  );
  expect(catalog?.provider).toBe("opencode");
  expect(catalog?.models.map((model) => model.id)).toEqual([
    "opencode/big-pickle",
    "aiberm/gpt-5.6-luna",
  ]);
  expect(catalog?.models[0]?.reasoningEfforts).toEqual(["low", "medium", "high"]);
});

test("falls back to the plain catalog when verbose output is empty", async () => {
  const catalog = await discoverOpenCodeCatalog(
    [process.execPath, FIXTURE, "models"],
    process.cwd(),
    {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      COFORGE_OPENCODE_MODELS_OUTPUT: "",
    },
  );
  expect(catalog?.models.map((model) => model.id)).toEqual([
    "opencode/big-pickle",
    "aiberm/gpt-5.6-luna",
  ]);
  expect(catalog?.models[0]?.reasoningEfforts).toEqual([]);
});

test("no catalog (never a thrown error) when the CLI cannot be run", async () => {
  expect(
    await discoverOpenCodeCatalog(["/nonexistent/opencode"], process.cwd(), {}, 200),
  ).toBeUndefined();
});
