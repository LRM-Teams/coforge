import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ANTIGRAVITY_MIN_CLI_VERSION,
  isAntigravityVersionUnsupported,
} from "#src/code-agent/antigravity/version";
import {
  discoverCodeAgentCatalogs,
  discoverCodeAgentInventory,
  discoverExternalCodeAgents,
  loadCachedCodeAgentCatalogs,
  type ExternalCodeAgentProbe,
} from "#src/code-agent/runtime-inventory";
import {
  ANTIGRAVITY_DISCOVERY_BUDGET_MS,
  CATALOG_DISCOVERY_BUDGET_MS,
} from "./catalog-discovery-budget";

import { captureDaemonLogs } from "./log-capture";

/** An inventory pass runs every provider's discovery at once and ends with the slowest. */
const PASS_BUDGET_MS = Math.max(CATALOG_DISCOVERY_BUDGET_MS, ANTIGRAVITY_DISCOVERY_BUDGET_MS);

const MODELS_FIXTURE = new URL("./fixtures/antigravity-models-fixture.ts", import.meta.url)
  .pathname;

function agyProbe(versionOutput: string, path = "/bin/agy"): ExternalCodeAgentProbe {
  return {
    which: (name) => (name === "agy" ? path : undefined),
    spawn: () => ({
      stdout: new Blob([versionOutput]).stream(),
      exited: Promise.resolve(0),
    }),
  };
}

describe("Antigravity CLI version gate", () => {
  test("compares dotted numbers, so 1.10.0 is newer than 1.2.10 and an unreadable version never gates", () => {
    expect(ANTIGRAVITY_MIN_CLI_VERSION).toBe("1.2.10");
    expect(isAntigravityVersionUnsupported("1.2.9")).toBe(true);
    expect(isAntigravityVersionUnsupported("1.1.15")).toBe(true);
    expect(isAntigravityVersionUnsupported("1.2.10")).toBe(false);
    expect(isAntigravityVersionUnsupported("1.2.13")).toBe(false);
    expect(isAntigravityVersionUnsupported("1.10.0")).toBe(false);
    expect(isAntigravityVersionUnsupported("2.0.0")).toBe(false);
    expect(isAntigravityVersionUnsupported("unknown")).toBe(false);
  });

  test("reports the runtime with the version `agy --version` prints", async () => {
    await expect(discoverExternalCodeAgents(agyProbe("1.2.13\n"))).resolves.toEqual([
      { provider: "antigravity", version: "1.2.13", displayName: "Antigravity CLI" },
    ]);
  });

  test("reads the version from the last token when a wrapper prints a line first", async () => {
    await expect(
      discoverExternalCodeAgents(agyProbe("agy wrapper: using profile default\n1.2.13\n")),
    ).resolves.toEqual([
      { provider: "antigravity", version: "1.2.13", displayName: "Antigravity CLI" },
    ]);
  });

  test("does not report the runtime, and logs a warning, when the CLI is below the baseline", async () => {
    const { records } = await captureDaemonLogs(async () => {
      await expect(discoverExternalCodeAgents(agyProbe("1.2.9\n"))).resolves.toEqual([]);
    });
    const warning = records.find(
      (record) => record.properties.event === "code_agent_runtime:version_unsupported",
    );
    expect(warning?.properties).toMatchObject({
      provider: "antigravity",
      executable_name: "agy",
      version: "1.2.9",
      minimum_version: ANTIGRAVITY_MIN_CLI_VERSION,
      outcome: "unavailable",
    });
  });

  test("reports the runtime when the version output cannot be confidently parsed", async () => {
    await expect(discoverExternalCodeAgents(agyProbe("unknown\n"))).resolves.toEqual([
      { provider: "antigravity", version: "unknown", displayName: "Antigravity CLI" },
    ]);
  });
});

describe("Antigravity CLI model catalog in the inventory", () => {
  // Pi's catalog is discovered in the same pass; a fixture home keeps that discovery off the
  // developer's real Pi configuration.
  const environment = { HOME: "/fixture/home", PATH: "", PI_OFFLINE: "1" };

  test(
    "discovers the catalog of an installed runtime through `agy models`",
    async () => {
      const inventory = await discoverCodeAgentInventory({
        probe: agyProbe("1.2.13\n"),
        commands: { antigravity: [process.execPath, MODELS_FIXTURE, "models"] },
        environment,
      });

      expect(inventory.runtimes).toContainEqual({
        provider: "antigravity",
        version: "1.2.13",
        displayName: "Antigravity CLI",
      });
      const catalog = inventory.catalogs.find((entry) => entry.provider === "antigravity");
      expect(catalog?.models).toHaveLength(14);
      expect(catalog?.models[0]).toMatchObject({
        id: "gemini-3.8-flash-high",
        displayName: "Gemini 3.8 Flash (High)",
      });
    },
    PASS_BUDGET_MS,
  );

  test(
    "keeps the installed runtime when its catalog is unavailable",
    async () => {
      const inventory = await discoverCodeAgentInventory({
        probe: agyProbe("1.2.13\n"),
        commands: { antigravity: [process.execPath, "-e", "process.exit(1)"] },
        environment,
      });

      expect(inventory.runtimes.some((runtime) => runtime.provider === "antigravity")).toBe(true);
      expect(inventory.catalogs.some((catalog) => catalog.provider === "antigravity")).toBe(false);
    },
    PASS_BUDGET_MS,
  );

  test(
    "does not spawn the catalog command once the runtime is gated out by version",
    async () => {
      const marker = join(
        tmpdir(),
        `coforge-antigravity-catalog-should-not-spawn-${crypto.randomUUID()}`,
      );
      try {
        const inventory = await discoverCodeAgentInventory({
          probe: agyProbe("1.2.9\n"),
          commands: {
            antigravity: [
              process.execPath,
              "-e",
              `require("fs").writeFileSync(${JSON.stringify(marker)}, "spawned")`,
            ],
          },
          environment,
        });
        expect(inventory.runtimes.some((runtime) => runtime.provider === "antigravity")).toBe(
          false,
        );
        expect(inventory.catalogs.some((catalog) => catalog.provider === "antigravity")).toBe(
          false,
        );
        expect(await Bun.file(marker).exists()).toBe(false);
      } finally {
        await Bun.file(marker)
          .delete()
          .catch(() => undefined);
      }
    },
    PASS_BUDGET_MS,
  );

  test(
    "caches the catalog keyed by the executable, so the cached read serves it without spawning",
    async () => {
      const stateDirectory = await mkdtemp(join(tmpdir(), "coforge-antigravity-catalog-state-"));
      const binDirectory = await mkdtemp(join(tmpdir(), "coforge-antigravity-catalog-bin-")).catch(
        async (error: unknown) => {
          await rm(stateDirectory, { recursive: true, force: true });
          throw error;
        },
      );
      const agyPath = join(binDirectory, "agy");
      try {
        await Bun.write(agyPath, "#!/bin/sh\nexit 0\n");
        const runtimes = [
          { provider: "antigravity" as const, version: "1.2.13", displayName: "Antigravity CLI" },
        ];
        const options = {
          probe: agyProbe("1.2.13\n", agyPath),
          commands: { antigravity: [process.execPath, MODELS_FIXTURE, "models"] as const },
          environment,
          cacheDirectory: stateDirectory,
        };
        const live = await discoverCodeAgentCatalogs(runtimes, options);
        expect(live.find((catalog) => catalog.provider === "antigravity")?.models).toHaveLength(14);

        // The cached read has no `commands`: it can only serve what the live pass wrote.
        const cached = await loadCachedCodeAgentCatalogs(runtimes, {
          probe: options.probe,
          environment,
          cacheDirectory: stateDirectory,
        });
        expect(
          cached.catalogs.find((catalog) => catalog.provider === "antigravity")?.models,
        ).toHaveLength(14);
      } finally {
        await rm(stateDirectory, { recursive: true, force: true });
        await rm(binDirectory, { recursive: true, force: true });
      }
    },
    PASS_BUDGET_MS,
  );
});
