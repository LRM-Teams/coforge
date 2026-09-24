import { describe, expect, test } from "bun:test";
import { configure, reset, type LogRecord } from "@logtape/logtape";
import {
  discoverCodeAgentInventory,
  discoverExternalCodeAgents,
  type ExternalCodeAgentProbe,
} from "#src/code-agent/runtime-inventory";
import { KIRO_MIN_CLI_VERSION } from "#src/code-agent/kiro/connection";

function kiroProbe(versionOutput: string): ExternalCodeAgentProbe {
  return {
    which: (name) => (name === "kiro-cli" ? "/bin/kiro-cli" : undefined),
    spawn: () => ({
      stdout: new Blob([versionOutput]).stream(),
      exited: Promise.resolve(0),
    }),
  };
}

async function captureWarnings(run: () => Promise<unknown>) {
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
    await run();
  } finally {
    await reset();
  }
  return records;
}

describe("Kiro minimum CLI version gate", () => {
  test("does not report Kiro and logs a warning when the CLI is below the compatibility baseline", async () => {
    const records = await captureWarnings(async () => {
      const runtimes = await discoverExternalCodeAgents(kiroProbe("kiro-cli 2.16.0\n"));
      expect(runtimes).toEqual([]);
    });
    const warning = records.find(
      (record) => record.properties.event === "code_agent_runtime:version_unsupported",
    );
    expect(warning?.properties).toMatchObject({
      provider: "kiro",
      executable_name: "kiro-cli",
      version: "2.16.0",
      minimum_version: KIRO_MIN_CLI_VERSION,
      outcome: "unavailable",
    });
  });

  test.each([
    ["kiro-cli 2.21.2\n", "2.21.2"],
    ["kiro-cli 2.22.0\n", "2.22.0"],
  ])(
    "reports Kiro when the CLI meets or exceeds the baseline (%s)",
    async (versionOutput, version) => {
      await expect(discoverExternalCodeAgents(kiroProbe(versionOutput))).resolves.toEqual([
        { provider: "kiro", version, displayName: "Kiro" },
      ]);
    },
  );

  test("reports Kiro when the version output cannot be confidently parsed", async () => {
    await expect(discoverExternalCodeAgents(kiroProbe("unknown\n"))).resolves.toEqual([
      { provider: "kiro", version: "unknown", displayName: "Kiro" },
    ]);
  });

  test("skips the Kiro catalog probe once the runtime is gated out by version", async () => {
    // A catalog command that would fail the test (by writing an unexpected marker) if it were
    // ever spawned: catalog discovery only spawns it when a Kiro runtime was reported.
    const marker = `${Bun.env.TMPDIR ?? "/tmp"}/coforge-kiro-catalog-should-not-spawn-${crypto.randomUUID()}`;
    try {
      const inventory = await discoverCodeAgentInventory({
        probe: kiroProbe("kiro-cli 2.16.0\n"),
        commands: {
          kiro: [
            process.execPath,
            "-e",
            `require("fs").writeFileSync(${JSON.stringify(marker)}, "spawned")`,
          ],
        },
      });
      expect(inventory.runtimes.some((runtime) => runtime.provider === "kiro")).toBe(false);
      expect(inventory.catalogs.some((catalog) => catalog.provider === "kiro")).toBe(false);
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally {
      await Bun.file(marker)
        .delete()
        .catch(() => undefined);
    }
  });
});
