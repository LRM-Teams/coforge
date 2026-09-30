import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ANTIGRAVITY_DISCOVERY_BUDGET_MS } from "./catalog-discovery-budget";
import {
  discoverAntigravityCatalog,
  parseAntigravityModelList,
} from "#src/code-agent/antigravity/catalog";

const FIXTURE = new URL("./fixtures/antigravity-models-fixture.ts", import.meta.url).pathname;
const MODELS_FIXTURE_PATH = new URL("./fixtures/antigravity-models.txt", import.meta.url).pathname;

test("parses the real 1.2.13 output: one `<slug><TAB><label>` model per line", async () => {
  const output = await readFile(MODELS_FIXTURE_PATH, "utf8");
  const models = parseAntigravityModelList(output);
  expect(models.map((model) => model.id)).toEqual([
    "gemini-3.8-flash-high",
    "gemini-3.8-flash-medium",
    "gemini-3.8-flash-low",
    "gemini-3.7-flash-high",
    "gemini-3.7-flash-medium",
    "gemini-3.7-flash-low",
    "gemini-3.6-flash-high",
    "gemini-3.6-flash-medium",
    "gemini-3.6-flash-low",
    "gemini-3.1-pro-high",
    "gemini-3.1-pro-low",
    "claude-sonnet-4-6",
    "claude-opus-4-6-thinking",
    "gpt-oss-120b-medium",
  ]);
  // The CLI marks no default and bakes the effort into the slug, so nothing is recommended and no
  // separate reasoning control is offered.
  expect(models[0]).toEqual({
    id: "gemini-3.8-flash-high",
    displayName: "Gemini 3.8 Flash (High)",
    description: "",
    modelProvider: "",
    reasoningEfforts: [],
    defaultReasoning: "",
    recommended: false,
  });
  expect(models.every((model) => !model.recommended && model.reasoningEfforts.length === 0)).toBe(
    true,
  );
  expect(models.at(-1)).toMatchObject({
    id: "gpt-oss-120b-medium",
    displayName: "GPT-OSS 120B (Medium)",
  });
});

test("ignores a line without a tab, such as a wrapper banner, and blank lines", () => {
  const models = parseAntigravityModelList(
    [
      "agy wrapper: using profile default",
      "",
      "gemini-3.1-pro-low\tGemini 3.1 Pro (Low)",
      "",
      "Fetching available models...",
    ].join("\n"),
  );
  expect(models).toEqual([
    expect.objectContaining({ id: "gemini-3.1-pro-low", displayName: "Gemini 3.1 Pro (Low)" }),
  ]);
});

test("splits on the first tab only, falls back to the id for an empty label, and strips ANSI", () => {
  const models = parseAntigravityModelList(
    ["a-model\tLabel\twith\ttabs", "b-model\t", "\x1b[32mc-model\x1b[0m\tC Model\r"].join("\n"),
  );
  expect(models).toEqual([
    expect.objectContaining({ id: "a-model", displayName: "Label\twith\ttabs" }),
    expect.objectContaining({ id: "b-model", displayName: "b-model" }),
    expect.objectContaining({ id: "c-model", displayName: "C Model" }),
  ]);
});

test("an empty slug is not a model, and no tab-separated line means no catalog", () => {
  expect(parseAntigravityModelList("\tOrphan label\n")).toEqual([]);
  expect(parseAntigravityModelList("Fetching available models...\n")).toEqual([]);
  expect(parseAntigravityModelList("")).toEqual([]);
});

test(
  "discoverAntigravityCatalog parses a live `agy models` process and ignores its stderr",
  async () => {
    const catalog = await discoverAntigravityCatalog(
      [process.execPath, FIXTURE, "models"],
      tmpdir(),
      {
        COFORGE_ANTIGRAVITY_MODELS_OUTPUT: "gemini-3.1-pro-high\tGemini 3.1 Pro (High)\n",
      },
    );
    expect(catalog).toEqual({
      provider: "antigravity",
      models: [
        {
          id: "gemini-3.1-pro-high",
          displayName: "Gemini 3.1 Pro (High)",
          description: "",
          modelProvider: "",
          reasoningEfforts: [],
          defaultReasoning: "",
          recommended: false,
        },
      ],
    });
  },
  ANTIGRAVITY_DISCOVERY_BUDGET_MS,
);

test(
  "discoverAntigravityCatalog reads the whole real capture from the CLI's stdout",
  async () => {
    const catalog = await discoverAntigravityCatalog(
      [process.execPath, FIXTURE, "models"],
      tmpdir(),
      {},
    );
    expect(catalog?.models).toHaveLength(14);
  },
  ANTIGRAVITY_DISCOVERY_BUDGET_MS,
);

test(
  "discoverAntigravityCatalog keeps SSH session markers away from agy models",
  async () => {
    // The fixture fails the command if any SSH marker reaches it.
    const catalog = await discoverAntigravityCatalog(
      [process.execPath, FIXTURE, "models"],
      tmpdir(),
      { SSH_CLIENT: "10.0.0.1 1 22", SSH_CONNECTION: "10.0.0.1 1 10.0.0.2 22" },
    );
    expect(catalog?.models).toHaveLength(14);
  },
  ANTIGRAVITY_DISCOVERY_BUDGET_MS,
);

test(
  "discoverAntigravityCatalog returns undefined on a non-zero exit",
  async () => {
    const catalog = await discoverAntigravityCatalog(
      [process.execPath, FIXTURE, "models"],
      tmpdir(),
      {
        COFORGE_ANTIGRAVITY_MODELS_EXIT: "1",
      },
    );
    expect(catalog).toBeUndefined();
  },
  ANTIGRAVITY_DISCOVERY_BUDGET_MS,
);

test(
  "discoverAntigravityCatalog returns undefined when the output lists no model",
  async () => {
    const catalog = await discoverAntigravityCatalog(
      [process.execPath, FIXTURE, "models"],
      tmpdir(),
      {
        COFORGE_ANTIGRAVITY_MODELS_OUTPUT: "not logged in\n",
      },
    );
    expect(catalog).toBeUndefined();
  },
  ANTIGRAVITY_DISCOVERY_BUDGET_MS,
);

test(
  "discoverAntigravityCatalog times out instead of hanging when the CLI never exits",
  async () => {
    const catalog = await discoverAntigravityCatalog(
      [process.execPath, FIXTURE, "hang-models"],
      tmpdir(),
      {},
      30,
    );
    expect(catalog).toBeUndefined();
  },
  ANTIGRAVITY_DISCOVERY_BUDGET_MS,
);
