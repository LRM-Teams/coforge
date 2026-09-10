import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverCodeAgentInventory,
  discoverExternalCodeAgents,
  type ExternalCodeAgentProbe,
} from "../src/code-agent/runtime-inventory";
import {
  probeClaudeCodeVersion,
  resolveClaudeCodeExecutable,
} from "../src/code-agent/claude-code/runtime";
import { COFORGE_DAEMON_VERSION } from "../src/version";

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
        environment: { HOME: home, PATH: "" },
      });
      expect(inventory.runtimes).toContainEqual({
        provider: "pi",
        version: "0.84.3",
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
              ? "kiro-cli 1.24.0"
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
      { provider: "kiro", version: "1.24.0", displayName: "Kiro" },
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

  test("detects Codex, Claude Code, and Kiro as external runtimes without installed Pi", async () => {
    const runtimes = await discoverExternalCodeAgents(
      probeFor({
        codex: { path: "/bin/codex", version: "codex-cli 0.151.0\n" },
        claude: { path: "/bin/claude", version: "2.1.0\n" },
        "kiro-cli": { path: "/bin/kiro-cli", version: "kiro-cli 1.24.0\n" },
        pi: { path: "/bin/pi", version: "0.9.1\n" },
      }),
    );

    expect(runtimes).toEqual([
      { provider: "codex", version: "0.151.0", displayName: "Codex" },
      { provider: "claude-code", version: "2.1.0", displayName: "Claude Code" },
      { provider: "kiro", version: "1.24.0", displayName: "Kiro" },
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
        "kiro-cli": { path: "/bin/kiro-cli", version: "kiro-cli 1.24.0\n" },
      }),
      commands: { kiro: [process.execPath, "-e", "process.exit(1)"] },
      environment: { HOME: "/fixture/home", PATH: "" },
    });

    expect(inventory.runtimes).toContainEqual({
      provider: "kiro",
      version: "1.24.0",
      displayName: "Kiro",
    });
    expect(inventory.catalogs.some((catalog) => catalog.provider === "kiro")).toBe(false);
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
        claude: { path: "/bin/claude", version: "2.1.0\n" },
        pi: { path: "/bin/pi", version: "0.9.1\n" },
      }),
      commands: {
        codex: fixture("codex-app-server.ts"),
      },
    });

    expect(inventory.runtimes[0]).toEqual({
      provider: "coforge",
      version: COFORGE_DAEMON_VERSION,
      displayName: "CoForge",
    });
    expect(inventory.runtimes[1]).toEqual({
      provider: "pi",
      version: "0.84.3",
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
            id: "claude-sonnet-4-6",
            displayName: "Claude Sonnet 4.6",
            description: "",
            modelProvider: "",
            reasoningEfforts: ["low", "medium", "high", "max"],
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
            id: "claude-haiku-4-5",
            displayName: "Claude Haiku 4.5",
            description: "",
            modelProvider: "",
            reasoningEfforts: ["low", "medium", "high"],
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
            id: "claude-sonnet-4-5",
            displayName: "Claude Sonnet 4.5",
            description: "",
            modelProvider: "",
            reasoningEfforts: ["low", "medium", "high", "max"],
            defaultReasoning: "medium",
            recommended: false,
          },
        ],
      },
    ]);
  });
});
