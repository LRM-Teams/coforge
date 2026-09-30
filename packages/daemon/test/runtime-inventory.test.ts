import { describe, expect, test } from "bun:test";
import { PI_SDK_VERSION } from "@coforge/agent";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeStaticCatalog,
  discoverCodeAgentInventory,
  discoverPiCatalog,
  discoverExternalCodeAgents,
  loadCachedCodeAgentCatalogs,
  type ExternalCodeAgentProbe,
} from "#src/code-agent/runtime-inventory";
import { ClaudeCodeProvider } from "#src/code-agent/claude-code/provider";
import { fileStatCacheKey, inventoryCachePath } from "#src/code-agent/runtime-inventory-cache";
import {
  probeClaudeCodeVersion,
  resolveClaudeCodeExecutable,
} from "#src/code-agent/claude-code/runtime";
import { COFORGE_DAEMON_VERSION } from "#src/version";

function probeFor(
  runtimes: Record<string, { path: string; version: string; exitCode?: number }>,
): ExternalCodeAgentProbe {
  return {
    which: (name) => runtimes[name]?.path,
    spawn: (executable) => {
      const runtime = Object.values(runtimes).find((candidate) => candidate.path === executable);
      return {
        stdout: new Blob([runtime?.version ?? ""]).stream(),
        exited: Promise.resolve(runtime?.exitCode ?? 0),
      };
    },
  };
}

describe("external Code Agent inventory", () => {
  test("reports embedded Pi and discovers custom models from host Pi resources", async () => {
    const home = await mkdtemp(join(tmpdir(), "coforge-pi-inventory-"));
    const agentDir = join(home, ".pi", "agent");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          fixture: {
            baseUrl: "http://localhost.invalid/v1",
            apiKey: "local",
            models: [{ id: "host-model", name: "Host Model", api: "openai-completions" }],
          },
        },
      }),
    );
    try {
      const inventory = await discoverCodeAgentInventory({
        probe: probeFor({}),
        cwd: home,
        environment: { HOME: home, PATH: "", PI_OFFLINE: "1" },
      });
      expect(inventory.runtimes).toContainEqual({
        provider: "pi",
        version: PI_SDK_VERSION,
        displayName: "Pi",
      });
      expect(
        inventory.catalogs.find((catalog) => catalog.provider === "pi")?.models,
      ).toContainEqual(expect.objectContaining({ id: "host-model", modelProvider: "fixture" }));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("searches user CLI directories when the Daemon service PATH is minimal", async () => {
    const searchedPaths: string[] = [];
    const probe: ExternalCodeAgentProbe = {
      which(name, searchPath) {
        searchedPaths.push(searchPath ?? "");
        if (name === "codex" && searchPath?.includes("/Users/frank/.local/bin")) {
          return "/Users/frank/.local/bin/codex";
        }
        if (name === "claude" && searchPath?.includes("/Users/frank/.local/bin")) {
          return "/Users/frank/.local/bin/claude";
        }
        if (name === "kiro-cli" && searchPath?.includes("/Users/frank/.local/bin")) {
          return "/Users/frank/.local/bin/kiro-cli";
        }
        return undefined;
      },
      spawn: (executable) => ({
        stdout: new Blob([
          executable.endsWith("codex")
            ? "codex-cli 0.151.0"
            : executable.endsWith("kiro-cli")
              ? "kiro-cli 2.21.2"
              : "2.1.0",
        ]).stream(),
        exited: Promise.resolve(0),
      }),
    };

    await expect(
      discoverExternalCodeAgents(probe, {
        HOME: "/Users/frank",
        PATH: "/usr/bin:/bin",
      }),
    ).resolves.toEqual([
      { provider: "codex", version: "0.151.0", displayName: "Codex" },
      { provider: "claude-code", version: "2.1.0", displayName: "Claude Code" },
      { provider: "kiro", version: "2.21.2", displayName: "Kiro" },
    ]);
    expect(searchedPaths.every((path) => path.includes("/Users/frank/.local/bin"))).toBe(true);
  });

  test("does not scan PATH for Pi because its SDK is embedded", async () => {
    const searchedPaths: string[] = [];
    const probe: ExternalCodeAgentProbe = {
      which(name, searchPath) {
        searchedPaths.push(searchPath ?? "");
        if (name === "pi" && searchPath?.includes("/opt/homebrew/bin")) {
          return "/opt/homebrew/bin/pi";
        }
        return undefined;
      },
      spawn: () => ({
        stdout: new Blob(["0.84.4\n"]).stream(),
        exited: Promise.resolve(0),
      }),
    };

    await expect(
      discoverExternalCodeAgents(
        probe,
        {
          HOME: "/Users/frank",
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        },
        "darwin",
      ),
    ).resolves.toEqual([]);
    expect(searchedPaths.every((path) => path.includes("/usr/local/bin"))).toBe(true);
  });

  test("resolves Claude Code from PATH before any platform fallback", async () => {
    await expect(resolveClaudeCodeExecutable(() => "/custom/bin/claude")).resolves.toBe(
      "/custom/bin/claude",
    );
  });

  test("parses Claude Code's version from its version output", async () => {
    await expect(
      probeClaudeCodeVersion("/bin/claude", () => ({
        stdout: new Blob(["Claude Code 2.1.7 (build abc)\n"]).stream(),
        exited: Promise.resolve(0),
      })),
    ).resolves.toBe("2.1.7");
  });

  test("does not inventory Claude Code when version probing fails", async () => {
    let killed = false;
    await expect(
      probeClaudeCodeVersion("/bin/claude", () => ({
        stdout: new Blob(["error\n"]).stream(),
        exited: Promise.resolve(1),
        kill: () => {
          killed = true;
        },
      })),
    ).resolves.toBeUndefined();
    expect(killed).toBe(true);
  });

  test("keeps a cached runtime when a later version probe temporarily fails", async () => {
    const home = await mkdtemp(join(tmpdir(), "coforge-runtime-cache-fallback-"));
    const executable = join(home, "codex");
    await Bun.write(executable, "fixture");
    const key = await fileStatCacheKey([executable]);
    expect(key).toBeDefined();
    await Bun.write(
      inventoryCachePath(home),
      JSON.stringify({
        codex: {
          key,
          runtime: { provider: "codex", version: "0.151.0", displayName: "Codex" },
        },
      }),
    );
    try {
      const probe: ExternalCodeAgentProbe = {
        which: (name) => (name === "codex" ? executable : undefined),
        probe: async () => undefined,
        spawn: () => ({
          stdout: new Blob(["broken\n"]).stream(),
          exited: Promise.resolve(1),
        }),
      };
      await expect(
        discoverExternalCodeAgents(probe, { HOME: home, PATH: "" }, "linux", undefined, home),
      ).resolves.toContainEqual({
        provider: "codex",
        version: "0.151.0",
        displayName: "Codex",
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("starts independent external runtime probes concurrently while preserving provider order", async () => {
    const started: string[] = [];
    let release!: () => void;
    const allStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const paths = {
      claude: "/bin/claude",
      "kiro-cli": "/bin/kiro-cli",
    };
    const probe: ExternalCodeAgentProbe = {
      which: (name) => paths[name as keyof typeof paths],
      spawn: (executable) => {
        started.push(executable);
        if (started.length === 2) release();
        const output = executable.endsWith("claude") ? "2.1.0\n" : "kiro-cli 2.21.2\n";
        return {
          stdout: new Blob([output]).stream(),
          exited: allStarted.then(() => 0),
        };
      },
    };

    await expect(discoverExternalCodeAgents(probe)).resolves.toEqual([
      { provider: "claude-code", version: "2.1.0", displayName: "Claude Code" },
      { provider: "kiro", version: "2.21.2", displayName: "Kiro" },
    ]);
    expect(started).toEqual(["/bin/claude", "/bin/kiro-cli"]);
  }, 6_000);

  test("kills a Claude Code version probe that exceeds its timeout", async () => {
    let killed = false;
    await expect(
      probeClaudeCodeVersion(
        "/bin/claude",
        () => ({
          stdout: new ReadableStream(),
          exited: new Promise(() => {}),
          kill: () => {
            killed = true;
          },
        }),
        10,
      ),
    ).resolves.toBeUndefined();
    expect(killed).toBe(true);
  });

  test("detects Codex, Claude Code, Kiro, and Cursor CLI as external runtimes without installed Pi", async () => {
    const runtimes = await discoverExternalCodeAgents(
      probeFor({
        codex: { path: "/bin/codex", version: "codex-cli 0.151.0\n" },
        claude: { path: "/bin/claude", version: "2.1.0\n" },
        "kiro-cli": { path: "/bin/kiro-cli", version: "kiro-cli 2.21.2\n" },
        "cursor-agent": { path: "/bin/cursor-agent", version: "2026.08.11-e8db854\n" },
        pi: { path: "/bin/pi", version: "0.9.1\n" },
      }),
    );

    expect(runtimes).toEqual([
      { provider: "codex", version: "0.151.0", displayName: "Codex" },
      { provider: "claude-code", version: "2.1.0", displayName: "Claude Code" },
      { provider: "kiro", version: "2.21.2", displayName: "Kiro" },
      { provider: "cursor", version: "2026.08.11-e8db854", displayName: "Cursor CLI" },
    ]);
  });

  test("omits unusable executables", async () => {
    await expect(
      discoverExternalCodeAgents(
        probeFor({ codex: { path: "/bin/codex", version: "", exitCode: 1 } }),
      ),
    ).resolves.toEqual([]);
  });

  test("uses the Codex app-server probe before reporting the runtime", async () => {
    const probed: string[] = [];
    const probe = probeFor({ codex: { path: "/bin/codex", version: "0.151.0" } });
    probe.probe = async (provider, executable) => {
      probed.push(`${provider}:${executable}`);
      return "0.151.0";
    };

    await expect(discoverExternalCodeAgents(probe)).resolves.toEqual([
      { provider: "codex", version: "0.151.0", displayName: "Codex" },
    ]);
    expect(probed).toEqual(["codex:/bin/codex"]);
  });

  test("preserves an installed Kiro runtime when its catalog is unavailable", async () => {
    const inventory = await discoverCodeAgentInventory({
      probe: probeFor({
        "kiro-cli": { path: "/bin/kiro-cli", version: "kiro-cli 2.21.2\n" },
      }),
      commands: { kiro: [process.execPath, "-e", "process.exit(1)"] },
      environment: { HOME: "/fixture/home", PATH: "" },
    });

    expect(inventory.runtimes).toContainEqual({
      provider: "kiro",
      version: "2.21.2",
      displayName: "Kiro",
    });
    expect(inventory.catalogs.some((catalog) => catalog.provider === "kiro")).toBe(false);
  });

  test("discovers a Cursor CLI model catalog for an installed runtime", async () => {
    const inventory = await discoverCodeAgentInventory({
      probe: probeFor({
        "cursor-agent": { path: "/bin/cursor-agent", version: "2026.08.11-e8db854\n" },
      }),
      commands: {
        cursor: [
          process.execPath,
          new URL("./fixtures/cursor-agent-fixture.ts", import.meta.url).pathname,
          "models",
        ],
      },
      environment: {
        HOME: "/fixture/home",
        PATH: "",
        COFORGE_CURSOR_MODELS_OUTPUT: "Available models\n\nauto - Auto (default)\n",
      },
    });

    expect(inventory.runtimes).toContainEqual({
      provider: "cursor",
      version: "2026.08.11-e8db854",
      displayName: "Cursor CLI",
    });
    expect(inventory.catalogs.find((catalog) => catalog.provider === "cursor")).toEqual({
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

  test("does not wait indefinitely for a runtime version probe", async () => {
    let killed = false;
    const probe: ExternalCodeAgentProbe = {
      which: (name) => (name === "codex" ? "/bin/codex" : undefined),
      spawn: () => ({
        stdout: new ReadableStream(),
        exited: new Promise(() => {}),
        kill: () => {
          killed = true;
        },
      }),
    };

    await expect(discoverExternalCodeAgents(probe)).resolves.toEqual([]);
    expect(killed).toBe(true);
  }, 6_000);

  test("discovers Codex and Pi catalogs and reports the maintained Claude Code catalog", async () => {
    const fixture = (name: string) =>
      [process.execPath, new URL(`./fixtures/${name}`, import.meta.url).pathname] as const;
    const inventory = await discoverCodeAgentInventory({
      probe: probeFor({
        codex: { path: "/bin/codex", version: "codex-cli 0.151.0\n" },
        claude: { path: "/bin/claude", version: "2.1.284 (Claude Code)\n" },
        pi: { path: "/bin/pi", version: "0.9.1\n" },
      }),
      commands: {
        codex: fixture("codex-app-server.ts"),
      },
      environment: { HOME: "/fixture/home", PATH: "", PI_OFFLINE: "1" },
    });

    expect(inventory.runtimes[0]).toEqual({
      provider: "coforge",
      version: COFORGE_DAEMON_VERSION,
      displayName: "CoForge",
    });
    expect(inventory.runtimes[1]).toEqual({
      provider: "pi",
      version: PI_SDK_VERSION,
      displayName: "Pi",
    });
    const coforgeCatalog = inventory.catalogs.find((catalog) => catalog.provider === "coforge");
    expect(coforgeCatalog).toBeDefined();
    expect(coforgeCatalog?.models.length).toBeGreaterThan(0);
    expect(coforgeCatalog?.models.length).toBeLessThanOrEqual(200);
    expect(new Set(coforgeCatalog?.models.map((model) => model.modelProvider))).toEqual(
      new Set([
        "deepseek",
        "minimax",
        "minimax-cn",
        "zai",
        "zai-coding-cn",
        "moonshotai",
        "moonshotai-cn",
        "kimi-coding",
        "qwen-token-plan",
        "qwen-token-plan-cn",
        "openrouter",
        "openai",
        "anthropic",
        "google",
        "xai",
        "xiaomi",
      ]),
    );
    expect(coforgeCatalog?.models).toContainEqual(
      expect.objectContaining({ id: "aion-labs/aion-2.0", modelProvider: "openrouter" }),
    );
    expect(coforgeCatalog?.models).toContainEqual(
      expect.objectContaining({ id: "deepseek/deepseek-chat", modelProvider: "openrouter" }),
    );
    const piCatalog = inventory.catalogs.find((catalog) => catalog.provider === "pi");
    expect(piCatalog).toEqual({ provider: "pi", models: [] });
    expect(inventory.catalogs.filter((catalog) => catalog.provider !== "pi")).toEqual([
      coforgeCatalog!,
      {
        provider: "codex",
        models: [
          {
            id: "gpt-5.6-sol",
            displayName: "GPT-5.6 Sol",
            description: "Primary coding model",
            modelProvider: "",
            reasoningEfforts: ["low", "medium", "high"],
            defaultReasoning: "low",
            recommended: true,
          },
        ],
      },
      {
        provider: "claude-code",
        models: [
          ...["opus", "fable", "sonnet", "haiku"].map((id) => ({
            id,
            displayName: `Claude ${id.charAt(0).toUpperCase()}${id.slice(1)}`,
            description: "",
            modelProvider: "",
            reasoningEfforts: [],
            defaultReasoning: "",
            recommended: false,
          })),
          {
            id: "claude-opus-5-5",
            displayName: "Claude Opus 5.5",
            description: "",
            modelProvider: "",
            reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
            defaultReasoning: "medium",
            recommended: false,
          },
          {
            id: "claude-sonnet-5-5",
            displayName: "Claude Sonnet 5.5",
            description: "",
            modelProvider: "",
            reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
            defaultReasoning: "medium",
            recommended: false,
          },
          {
            id: "claude-fable-5-1",
            displayName: "Claude Fable 5.1",
            description: "",
            modelProvider: "",
            reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
            defaultReasoning: "medium",
            recommended: false,
          },
          {
            id: "claude-opus-5",
            displayName: "Claude Opus 5",
            description: "",
            modelProvider: "",
            reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
            defaultReasoning: "medium",
            recommended: false,
          },
          {
            id: "claude-sonnet-5",
            displayName: "Claude Sonnet 5",
            description: "",
            modelProvider: "",
            reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
            defaultReasoning: "medium",
            recommended: false,
          },
          {
            id: "claude-fable-5",
            displayName: "Claude Fable 5",
            description: "",
            modelProvider: "",
            reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
            defaultReasoning: "medium",
            recommended: false,
          },
          {
            id: "claude-opus-4-8",
            displayName: "Claude Opus 4.8",
            description: "",
            modelProvider: "",
            reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
            defaultReasoning: "medium",
            recommended: false,
          },
          {
            id: "claude-opus-4-7",
            displayName: "Claude Opus 4.7",
            description: "",
            modelProvider: "",
            reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
            defaultReasoning: "medium",
            recommended: false,
          },
          {
            id: "claude-opus-4-6",
            displayName: "Claude Opus 4.6",
            description: "",
            modelProvider: "",
            reasoningEfforts: ["low", "medium", "high", "max"],
            defaultReasoning: "medium",
            recommended: false,
          },
          {
            id: "claude-sonnet-4-6",
            displayName: "Claude Sonnet 4.6",
            description: "",
            modelProvider: "",
            reasoningEfforts: ["low", "medium", "high", "max"],
            defaultReasoning: "medium",
            recommended: false,
          },
          {
            id: "claude-sonnet-4-5",
            displayName: "Claude Sonnet 4.5",
            description: "",
            modelProvider: "",
            reasoningEfforts: [],
            defaultReasoning: "",
            recommended: false,
          },
          {
            id: "claude-haiku-4-5",
            displayName: "Claude Haiku 4.5",
            description: "",
            modelProvider: "",
            reasoningEfforts: [],
            defaultReasoning: "",
            recommended: false,
          },
        ],
      },
    ]);
  });
});

test("Pi reasoning levels are the ones the SDK supports for each model", async () => {
  // Pi's thinkingLevelMap marks an unsupported level `null` and leaves a supported one out;
  // `xhigh` and `max` exist only when mapped. A model without reasoning offers no levels.
  const catalog = await discoverPiCatalog(
    tmpdir(),
    {},
    async () =>
      [
        { id: "no-off", provider: "openrouter", reasoning: true, thinkingLevelMap: { off: null } },
        {
          id: "with-max",
          provider: "anthropic",
          reasoning: true,
          thinkingLevelMap: { max: "max" },
        },
        { id: "plain", provider: "openai", reasoning: true },
        { id: "chat", provider: "openai", reasoning: false },
      ] as never,
  );
  expect(
    Object.fromEntries((catalog?.models ?? []).map((model) => [model.id, model.reasoningEfforts])),
  ).toEqual({
    "no-off": ["minimal", "low", "medium", "high"],
    "with-max": ["off", "minimal", "low", "medium", "high", "max"],
    plain: ["off", "minimal", "low", "medium", "high"],
    chat: [],
  });
});

describe("Claude Code model catalog minimum versions", () => {
  // https://code.claude.com/docs/en/model-config: Sonnet 5.5 requires Claude Code v2.1.284, Opus
  // 5.5 v2.1.280, Fable 5.1 v2.1.257. The docs state no minimum for the other pinned models.
  const ALIASES = ["opus", "fable", "sonnet", "haiku"];
  const PINNED_WITHOUT_MINIMUM = [
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-fable-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5",
    "claude-haiku-4-5",
  ];
  const FABLE_5_1 = "claude-fable-5-1";
  const OPUS_5_5 = "claude-opus-5-5";
  const SONNET_5_5 = "claude-sonnet-5-5";
  const cases: Array<{ version: string; listed: string[] }> = [
    { version: "2.1.0", listed: [] },
    { version: "2.1.256", listed: [] },
    { version: "2.1.257", listed: [FABLE_5_1] },
    { version: "2.1.279", listed: [FABLE_5_1] },
    { version: "2.1.280", listed: [FABLE_5_1, OPUS_5_5] },
    { version: "2.1.283", listed: [FABLE_5_1, OPUS_5_5] },
    { version: "2.1.284", listed: [FABLE_5_1, OPUS_5_5, SONNET_5_5] },
    { version: "2.2.0", listed: [FABLE_5_1, OPUS_5_5, SONNET_5_5] },
    { version: "3.0.0", listed: [FABLE_5_1, OPUS_5_5, SONNET_5_5] },
  ];
  const ids = (catalog: { models: Array<{ id: string }> } | undefined) =>
    catalog?.models.map((model) => model.id) ?? [];
  const expectListed = (modelIds: string[], listed: string[]) => {
    expect(modelIds).toEqual(expect.arrayContaining([...ALIASES, ...PINNED_WITHOUT_MINIMUM]));
    for (const id of [FABLE_5_1, OPUS_5_5, SONNET_5_5])
      expect(modelIds.includes(id)).toBe(listed.includes(id));
  };

  for (const { version, listed } of cases) {
    test(`the live inventory of Claude Code ${version} lists ${listed.length} of the 3 minimum-gated models`, async () => {
      const inventory = await discoverCodeAgentInventory({
        probe: probeFor({ claude: { path: "/bin/claude", version: `${version} (Claude Code)\n` } }),
        environment: { HOME: "/fixture/home", PATH: "", PI_OFFLINE: "1" },
      });
      expect(inventory.runtimes).toContainEqual({
        provider: "claude-code",
        version,
        displayName: "Claude Code",
      });
      expectListed(
        ids(inventory.catalogs.find((catalog) => catalog.provider === "claude-code")),
        listed,
      );
    });

    test(`the cached inventory of Claude Code ${version} lists the same models`, async () => {
      const { catalogs } = await loadCachedCodeAgentCatalogs(
        [{ provider: "claude-code", version, displayName: "Claude Code" }],
        { environment: { HOME: "/fixture/home", PATH: "" } },
      );
      expectListed(ids(catalogs.find((catalog) => catalog.provider === "claude-code")), listed);
    });

    test(`the Claude Code provider catalog for ${version} lists the same models`, async () => {
      const catalog = await new ClaudeCodeProvider().discoverModelCatalog({
        runtime: { provider: "claude-code", version, displayName: "Claude Code" },
      });
      expectListed(ids(catalog), listed);
    });
  }

  test("a version that is unknown or not a dotted number keeps the full list", async () => {
    const full = [...ALIASES, FABLE_5_1, OPUS_5_5, SONNET_5_5, ...PINNED_WITHOUT_MINIMUM];
    for (const catalog of [
      claudeStaticCatalog(),
      claudeStaticCatalog(undefined),
      claudeStaticCatalog(""),
      claudeStaticCatalog("not-a-version"),
      // A pre-release suffix is not a dotted number, so the comparison declines to gate on it.
      claudeStaticCatalog("2.1.100-beta.1"),
      await new ClaudeCodeProvider().discoverModelCatalog(),
      await new ClaudeCodeProvider().discoverModelCatalog({
        runtime: { provider: "claude-code", version: "", displayName: "Claude Code" },
      }),
    ])
      expect(ids(catalog).toSorted()).toEqual(full.toSorted());
  });

  test("a Claude Code upgrade re-reads the version through the probe cache and lists the new models", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "coforge-claude-catalog-state-"));
    const binDirectory = await mkdtemp(join(tmpdir(), "coforge-claude-catalog-bin-"));
    const claudePath = join(binDirectory, "claude");
    try {
      await Bun.write(claudePath, "#!/bin/sh\necho old\n");
      const installed = { claude: { path: claudePath, version: "2.1.100 (Claude Code)\n" } };
      const inventory = () =>
        discoverCodeAgentInventory({
          probe: probeFor(installed),
          environment: { HOME: "/fixture/home", PATH: "", PI_OFFLINE: "1" },
          cacheDirectory: stateDirectory,
        });
      const claudeModelIds = async () =>
        ids((await inventory()).catalogs.find((catalog) => catalog.provider === "claude-code"));

      expectListed(await claudeModelIds(), []);

      // A new binary has a new size, so the cache key changes and the probe runs again.
      await Bun.write(claudePath, "#!/bin/sh\necho upgraded claude\n");
      installed.claude.version = "2.1.285 (Claude Code)\n";
      expectListed(await claudeModelIds(), [FABLE_5_1, OPUS_5_5, SONNET_5_5]);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
      await rm(binDirectory, { recursive: true, force: true });
    }
  });

  test("the aliases are listed for every version, before the pinned models", () => {
    for (const { version } of cases)
      expect(ids(claudeStaticCatalog(version)).slice(0, 4)).toEqual(ALIASES);
  });
});
