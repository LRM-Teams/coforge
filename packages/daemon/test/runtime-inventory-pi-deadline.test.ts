import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PI_CATALOG_DISCOVERY_TIMEOUT_MS,
  discoverCodeAgentCatalogs,
} from "#src/code-agent/runtime-inventory";
import { inventoryCachePath } from "#src/code-agent/runtime-inventory-cache";
import { captureDaemonLogs } from "./log-capture";

/** Pi's model discovery runs in this process, so a test forces a hung one through `piModels`.
 * The test waits out the real deadline, so it needs a runner timeout above it; the margin covers
 * a loaded machine, not the product's bound. */
const PI_DEADLINE_TEST_TIMEOUT_MS = PI_CATALOG_DISCOVERY_TIMEOUT_MS + 5_000;

test(
  "a Pi discovery that never settles ends at the catalog deadline, is not cached, and its late failure is observed",
  async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "coforge-pi-deadline-state-"));
    const home = await mkdtemp(join(tmpdir(), "coforge-pi-deadline-home-"));
    // Both key files exist, so a catalog that came back would be cached rather than skipped.
    const agentDir = join(home, ".pi", "agent");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "models.json"), "{}");
    await Bun.write(join(agentDir, "auth.json"), "{}");
    try {
      let failLate!: (error: Error) => void;
      const hungDiscovery = new Promise<never>((_, reject) => {
        failLate = reject;
      });
      const { result, records } = await captureDaemonLogs(async () => {
        const startedAt = performance.now();
        const catalogs = await discoverCodeAgentCatalogs(
          [{ provider: "pi", version: "0.0.0", displayName: "Pi" }],
          {
            cwd: home,
            environment: { HOME: home, PATH: "" },
            piModels: () => hungDiscovery,
            cacheDirectory: stateDirectory,
          },
        );
        return { catalogs, elapsedMs: performance.now() - startedAt };
      });

      // The inventory is not held past the deadline, and Pi is simply absent from this pass.
      expect(result.elapsedMs).toBeLessThan(PI_CATALOG_DISCOVERY_TIMEOUT_MS + 2_000);
      expect(result.catalogs.map((catalog) => catalog.provider)).toEqual(["coforge"]);
      expect(await Bun.file(inventoryCachePath(stateDirectory)).exists()).toBe(false);

      const failure = records.find(
        (record) => record.properties.event === "code_agent_catalog:discovery_failed",
      );
      expect(failure?.properties).toMatchObject({
        provider: "pi",
        stage: "get_available_models",
        error_message: `model catalog discovery timed out after ${PI_CATALOG_DISCOVERY_TIMEOUT_MS} ms`,
        outcome: "unavailable",
        discovery_id: expect.any(String),
      });
      expect(failure?.properties.elapsed_ms).toBeGreaterThanOrEqual(
        PI_CATALOG_DISCOVERY_TIMEOUT_MS,
      );

      // The abandoned discovery still runs in-process. When it fails, nothing awaits it any more.
      // The runner fails a test on an unhandled rejection, so reaching the end proves the failure
      // was observed; it must not reach the logs either.
      failLate(new Error("late failure naming /Users/fixture/.pi/agent/auth.json"));
      await new Promise((resolve) => setImmediate(resolve));
      expect(JSON.stringify(records)).not.toContain("auth.json");
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  },
  PI_DEADLINE_TEST_TIMEOUT_MS,
);
