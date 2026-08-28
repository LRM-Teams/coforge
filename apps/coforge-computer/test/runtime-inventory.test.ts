import { describe, expect, test } from "bun:test";
import { discoverExternalRuntimes, type ExternalRuntimeProbe } from "../src/runtime/inventory";

function probeFor(
  installed: Record<string, { path: string; version: string }>,
): ExternalRuntimeProbe {
  return {
    which: (name) => installed[name]?.path,
    spawn: (executable) => {
      const runtime = Object.values(installed).find(({ path }) => path === executable);
      return {
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`${runtime?.version}\n`));
            controller.close();
          },
        }),
        exited: Promise.resolve(0),
      };
    },
  };
}

describe("external runtime inventory", () => {
  test("reports a user-installed Pi found on PATH", async () => {
    await expect(
      discoverExternalRuntimes(probeFor({ pi: { path: "/home/user/bin/pi", version: "0.9.1" } })),
    ).resolves.toEqual([{ provider: "pi", version: "0.9.1", kind: "external" }]);
  });

  test("keeps Claude Code identity distinct from its PATH executable name", async () => {
    await expect(
      discoverExternalRuntimes(
        probeFor({ claude: { path: "/home/user/bin/claude", version: "1.0.0" } }),
      ),
    ).resolves.toEqual([{ provider: "claude-code", version: "1.0.0", kind: "external" }]);
  });

  test("does not add built-in Pi without an external PATH entry", async () => {
    await expect(discoverExternalRuntimes(probeFor({}))).resolves.toEqual([]);
  });

  test("does not report metadata when version reading fails", async () => {
    await expect(
      discoverExternalRuntimes(probeFor({ pi: { path: "/home/user/bin/pi", version: "" } })),
    ).resolves.toEqual([]);
  });
});
