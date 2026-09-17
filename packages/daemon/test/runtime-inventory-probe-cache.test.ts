import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverCodeAgentCatalogs,
  discoverExternalCodeAgents,
  loadCachedCodeAgentCatalogs,
  type ExternalCodeAgentProbe,
} from "../src/code-agent/runtime-inventory";
import { fileStatCacheKey, writeInventoryCache } from "../src/code-agent/runtime-inventory-cache";

describe("Code Agent probe cache", () => {
  test("skips the version spawn when the cached probe key still matches the executable", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "coforge-probe-cache-state-"));
    const binDirectory = await mkdtemp(join(tmpdir(), "coforge-probe-cache-bin-"));
    const codexPath = join(binDirectory, "codex");
    await Bun.write(codexPath, "#!/bin/sh\necho codex\n");
    try {
      let spawnCalls = 0;
      const probe: ExternalCodeAgentProbe = {
        which: (name) => (name === "codex" ? codexPath : undefined),
        spawn: () => {
          spawnCalls++;
          return { stdout: new Blob(["codex-cli 0.151.0"]).stream(), exited: Promise.resolve(0) };
        },
      };

      const first = await discoverExternalCodeAgents(
        probe,
        { PATH: "" },
        undefined,
        undefined,
        stateDirectory,
      );
      expect(first).toEqual([{ provider: "codex", version: "0.151.0", displayName: "Codex" }]);
      expect(spawnCalls).toBe(1);

      const second = await discoverExternalCodeAgents(
        probe,
        { PATH: "" },
        undefined,
        undefined,
        stateDirectory,
      );
      expect(second).toEqual(first);
      expect(spawnCalls).toBe(1);

      // Touching the executable changes its mtime, which invalidates the cache key.
      const future = new Date(Date.now() + 60_000);
      await utimes(codexPath, future, future);

      const third = await discoverExternalCodeAgents(
        probe,
        { PATH: "" },
        undefined,
        undefined,
        stateDirectory,
      );
      expect(third).toEqual(first);
      expect(spawnCalls).toBe(2);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
      await rm(binDirectory, { recursive: true, force: true });
    }
  });

  test("re-validates a cached Kiro runtime and drops it when below the ADR 0010 baseline", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "coforge-probe-cache-state-"));
    const binDirectory = await mkdtemp(join(tmpdir(), "coforge-probe-cache-bin-"));
    const kiroPath = join(binDirectory, "kiro-cli");
    await Bun.write(kiroPath, "#!/bin/sh\necho kiro-cli\n");
    try {
      // Simulate a cache entry an older daemon build wrote before the version gate existed.
      const key = await fileStatCacheKey([kiroPath]);
      await writeInventoryCache(stateDirectory, {
        kiro: { key: key!, runtime: { provider: "kiro", version: "2.16.0", displayName: "Kiro" } },
      });
      let spawnCalls = 0;
      const probe: ExternalCodeAgentProbe = {
        which: (name) => (name === "kiro-cli" ? kiroPath : undefined),
        spawn: () => {
          spawnCalls++;
          return { stdout: new Blob(["kiro-cli 2.16.0"]).stream(), exited: Promise.resolve(0) };
        },
      };

      const runtimes = await discoverExternalCodeAgents(
        probe,
        { PATH: "" },
        undefined,
        undefined,
        stateDirectory,
      );

      expect(runtimes).toEqual([]);
      // The executable itself is unchanged, so a stale cache hit is rejected without re-spawning;
      // a live re-probe would only reproduce the same gate outcome.
      expect(spawnCalls).toBe(0);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
      await rm(binDirectory, { recursive: true, force: true });
    }
  });

  test("without a cache directory, every discovery spawns again", async () => {
    let spawnCalls = 0;
    const probe: ExternalCodeAgentProbe = {
      which: (name) => (name === "codex" ? "/bin/codex" : undefined),
      spawn: () => {
        spawnCalls++;
        return { stdout: new Blob(["codex-cli 0.151.0"]).stream(), exited: Promise.resolve(0) };
      },
    };
    await discoverExternalCodeAgents(probe);
    await discoverExternalCodeAgents(probe);
    expect(spawnCalls).toBe(2);
  });

  test("caches the Pi model catalog keyed by models.json and auth.json, and invalidates on change", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "coforge-probe-cache-state-"));
    const home = await mkdtemp(join(tmpdir(), "coforge-probe-cache-pi-"));
    const agentDir = join(home, ".pi", "agent");
    await mkdir(agentDir, { recursive: true });
    const writeModels = (id: string) =>
      Bun.write(
        join(agentDir, "models.json"),
        JSON.stringify({
          providers: {
            fixture: {
              baseUrl: "http://localhost.invalid/v1",
              apiKey: "local",
              models: [{ id, name: id, api: "openai-completions" }],
            },
          },
        }),
      );
    await writeModels("host-model-1");
    const environment = { HOME: home, PATH: "", PI_OFFLINE: "1" };
    const runtimes = [{ provider: "pi" as const, version: "0.0.0", displayName: "Pi" }];
    try {
      await discoverCodeAgentCatalogs(runtimes, {
        cwd: home,
        environment,
        cacheDirectory: stateDirectory,
      });

      const cached = await loadCachedCodeAgentCatalogs(runtimes, {
        cwd: home,
        environment,
        cacheDirectory: stateDirectory,
      });
      expect(cached.needsRefresh).toBe(false);
      expect(cached.catalogs.find((catalog) => catalog.provider === "pi")?.models).toContainEqual(
        expect.objectContaining({ id: "host-model-1" }),
      );

      // Changing models.json invalidates the cached key.
      await writeModels("host-model-2");
      const stale = await loadCachedCodeAgentCatalogs(runtimes, {
        cwd: home,
        environment,
        cacheDirectory: stateDirectory,
      });
      expect(stale.needsRefresh).toBe(true);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  test("loadCachedCodeAgentCatalogs never spawns and needs a refresh when nothing is cached yet", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "coforge-probe-cache-state-"));
    try {
      const result = await loadCachedCodeAgentCatalogs(
        [{ provider: "codex", version: "0.151.0", displayName: "Codex" }],
        {
          probe: {
            which: () => "/bin/codex",
            spawn: () => ({ stdout: new Blob([]).stream(), exited: Promise.resolve(0) }),
          },
          cacheDirectory: stateDirectory,
        },
      );
      expect(result.needsRefresh).toBe(true);
      // CoForge's static catalog is always included; nothing dynamic is available yet.
      expect(result.catalogs.map((catalog) => catalog.provider)).toEqual(["coforge"]);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });
});
