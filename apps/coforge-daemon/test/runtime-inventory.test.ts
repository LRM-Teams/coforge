import { describe, expect, test } from "bun:test";
import {
  discoverCodeAgentInventory,
  discoverExternalCodeAgents,
  type ExternalCodeAgentProbe,
} from "../src/code-agent/runtime-inventory";

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
  test("detects Codex and Claude Code without reporting Pi", async () => {
    const runtimes = await discoverExternalCodeAgents(
      probeFor({
        codex: { path: "/bin/codex", version: "codex-cli 0.151.0\n" },
        claude: { path: "/bin/claude", version: "2.1.0\n" },
        pi: { path: "/bin/pi", version: "0.9.1\n" },
      }),
    );

    expect(runtimes).toEqual([
      { provider: "codex", version: "0.151.0", kind: "external" },
      { provider: "claude-code", version: "2.1.0", kind: "external" },
    ]);
  });

  test("omits unusable executables", async () => {
    await expect(
      discoverExternalCodeAgents(
        probeFor({ codex: { path: "/bin/codex", version: "", exitCode: 1 } }),
      ),
    ).resolves.toEqual([]);
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
      }),
      commands: {
        codex: fixture("codex-app-server.ts"),
        pi: fixture("pi-rpc.ts"),
      },
    });

    expect(inventory.catalogs).toEqual([
      {
        provider: "pi",
        models: [
          {
            id: "claude-sonnet-4-6",
            displayName: "Claude Sonnet 4.6",
            description: "",
            modelProvider: "anthropic",
            reasoningEfforts: ["off", "low", "medium", "high"],
            defaultReasoning: "",
            recommended: false,
          },
        ],
      },
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
