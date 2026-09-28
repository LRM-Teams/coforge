import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { discoverCursorCatalog, parseCursorModelList } from "#src/code-agent/cursor/catalog";

const FIXTURE = new URL("./fixtures/cursor-agent-fixture.ts", import.meta.url).pathname;
const MODELS_FIXTURE_PATH = new URL("./fixtures/cursor-models.txt", import.meta.url).pathname;

test("accepts a bare id, keeps unknown trailing markers in the label, and skips flag-like ids", () => {
  const models = parseCursorModelList(
    ["AVAILABLE MODELS", "tip: pick one", "bare-id", "gpt-x - GPT X (beta)", "--help"].join("\n"),
  );
  expect(models).toEqual([
    expect.objectContaining({ id: "bare-id", displayName: "bare-id", recommended: false }),
    expect.objectContaining({ id: "gpt-x", displayName: "GPT X (beta)", recommended: false }),
  ]);
});

test("parses id - Label lines, skipping the header, blank lines, and the trailing Tip", async () => {
  const output = await readFile(MODELS_FIXTURE_PATH, "utf8");
  const models = parseCursorModelList(output);
  expect(models).toContainEqual({
    id: "auto",
    displayName: "Auto",
    description: "",
    modelProvider: "",
    reasoningEfforts: [],
    defaultReasoning: "",
    recommended: true,
  });
  expect(models).toContainEqual({
    id: "gpt-5.3-codex",
    displayName: "Codex 5.3",
    description: "",
    modelProvider: "",
    reasoningEfforts: [],
    defaultReasoning: "",
    recommended: false,
  });
  expect(models.some((model) => model.id === "glm-5.2-max")).toBe(true);
  // Neither the header nor the Tip line ever parses as a model.
  expect(models.some((model) => model.displayName.includes("Tip"))).toBe(false);
  expect(models.some((model) => model.id === "Available models")).toBe(false);
});

test("strips ANSI escapes and recognizes (current) and (current, default) markers", () => {
  const output = [
    "Available models",
    "",
    "[32mauto[0m - Auto (default)",
    "sonnet - Sonnet (current)",
    "opus - Opus (current, default)",
    "plain - Plain",
    "",
    "Tip: use --model <id> to switch.",
  ].join("\n");
  expect(parseCursorModelList(output)).toEqual([
    expect.objectContaining({ id: "auto", displayName: "Auto", recommended: true }),
    expect.objectContaining({ id: "sonnet", displayName: "Sonnet", recommended: false }),
    expect.objectContaining({ id: "opus", displayName: "Opus", recommended: true }),
    expect.objectContaining({ id: "plain", displayName: "Plain", recommended: false }),
  ]);
});

test("skips unavailable/failure lines the CLI can print instead of a catalog", () => {
  const output = [
    "Available models",
    "",
    "No models available for this account.",
    "Failed to load models: network error",
    "auto - Auto (default)",
  ].join("\n");
  expect(parseCursorModelList(output)).toEqual([
    expect.objectContaining({ id: "auto", displayName: "Auto" }),
  ]);
});

test("discoverCursorCatalog parses a live `cursor-agent models` process", async () => {
  const catalog = await discoverCursorCatalog([process.execPath, FIXTURE, "models"], tmpdir(), {
    COFORGE_CURSOR_MODELS_OUTPUT: "Available models\n\nauto - Auto (default)\n",
  });
  expect(catalog).toEqual({
    provider: "cursor",
    models: [
      {
        id: "auto",
        displayName: "Auto",
        description: "",
        modelProvider: "",
        reasoningEfforts: [],
        defaultReasoning: "",
        recommended: true,
      },
    ],
  });
});

test("discoverCursorCatalog returns undefined on a non-zero exit", async () => {
  const catalog = await discoverCursorCatalog([process.execPath, FIXTURE, "models"], tmpdir(), {
    COFORGE_CURSOR_MODELS_EXIT: "1",
    COFORGE_CURSOR_MODELS_STDERR: "boom",
  });
  expect(catalog).toBeUndefined();
});

test("discoverCursorCatalog times out instead of hanging when the CLI never exits", async () => {
  const catalog = await discoverCursorCatalog(
    [process.execPath, FIXTURE, "hang-models"],
    tmpdir(),
    {},
    30,
  );
  expect(catalog).toBeUndefined();
});
