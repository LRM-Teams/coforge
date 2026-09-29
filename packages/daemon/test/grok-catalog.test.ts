import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parseGrokModelList } from "#src/code-agent/grok/catalog";

const MODELS_FIXTURE_PATH = new URL("./fixtures/grok-models.txt", import.meta.url).pathname;

test("parses the real 1.0.41 output: the `*` default bullet and the `-` bullets", async () => {
  const output = await readFile(MODELS_FIXTURE_PATH, "utf8");
  expect(parseGrokModelList(output)).toEqual([
    {
      id: "grok-4.7",
      displayName: "grok-4.7",
      description: "",
      modelProvider: "",
      reasoningEfforts: [],
      defaultReasoning: "",
      recommended: true,
    },
    expect.objectContaining({ id: "grok-4.7-build-fast", recommended: false }),
    expect.objectContaining({ id: "grok-4.6", recommended: false }),
    expect.objectContaining({ id: "grok-4.5", recommended: false }),
  ]);
});

test("skips the login line, the `Default model:` line and the header", () => {
  const models = parseGrokModelList(
    [
      "You are logged in with grok.com.",
      "Default model: grok-4.7",
      "Available models:",
      "  * grok-4.7 (default)",
      "  - grok-4.5",
      "",
    ].join("\n"),
  );
  expect(models.map((model) => [model.id, model.recommended])).toEqual([
    ["grok-4.7", true],
    ["grok-4.5", false],
  ]);
});

test("no bullets means no catalog (the caller reads that as unavailable)", () => {
  expect(parseGrokModelList("You are logged in with grok.com.\nDefault model: grok-4.7\n")).toEqual(
    [],
  );
});
