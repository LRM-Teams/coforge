import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { configure, reset, type LogRecord } from "@logtape/logtape";
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

test("catalog failure logs an error code and an honest message instead of asserting a login problem", async () => {
  const records: LogRecord[] = [];
  await configure({
    reset: true,
    sinks: {
      capture: (record) => {
        records.push(record);
      },
    },
    loggers: [
      { category: ["coforge", "daemon"], lowestLevel: "info", sinks: ["capture"] },
      { category: ["logtape", "meta"], lowestLevel: "error", sinks: ["capture"] },
    ],
  });
  try {
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
  } finally {
    await reset();
  }
  const failure = records.find((record) => record.properties.event === "kiro.catalog.unavailable");
  expect(failure?.message.join("")).toBe("Kiro v3 model discovery unavailable");
  expect(failure?.properties.error_code).toEqual(expect.any(String));
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
