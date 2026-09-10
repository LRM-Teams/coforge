import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { discoverKiroCatalog } from "../src/code-agent/kiro/catalog";

test("Kiro catalog fails closed when model discovery never completes", async () => {
  expect(
    await discoverKiroCatalog(
      [
        process.execPath,
        new URL("./fixtures/kiro-acp.ts", import.meta.url).pathname,
        "--catalog",
        "--missing-config",
      ],
      tmpdir(),
      {},
      30,
    ),
  ).toBeUndefined();
});

test.each(["", "--early-config", "--delayed-config"])(
  "Kiro discovers native models and per-model effort %s",
  async (flag) => {
    const catalog = await discoverKiroCatalog(
      [
        process.execPath,
        new URL("./fixtures/kiro-acp.ts", import.meta.url).pathname,
        "--catalog",
        flag,
      ],
      tmpdir(),
      {},
    );
    expect(catalog).toEqual({
      provider: "kiro",
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
        {
          id: "model-reasoning",
          displayName: "Reasoning",
          description: "",
          modelProvider: "",
          reasoningEfforts: ["low", "high"],
          defaultReasoning: "low",
          recommended: false,
        },
      ],
    });
  },
);
