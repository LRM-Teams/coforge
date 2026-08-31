import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readCodexUsage } from "../src/code-agent/codex/usage";

const fixture = new URL("./fixtures/codex-app-server.ts", import.meta.url).pathname;

test("reads Codex account usage and converts rate-limit windows", async () => {
  const result = await readCodexUsage(await mkdtemp(join(tmpdir(), "coforge-usage-")), {
    command: [process.execPath, fixture],
  });
  expect(result).toEqual({
    provider: "codex",
    planType: "plus",
    primary: { usedPercent: 25, windowDurationMinutes: 300, resetsAt: "2025-01-02T01:20:00.000Z" },
    secondary: {
      usedPercent: 75,
      windowDurationMinutes: 10080,
      resetsAt: "2026-01-09T00:00:00.000Z",
    },
  });
});

test("returns no snapshot when Codex is not logged in or does not support the method", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-usage-"));
  for (const flag of ["usage-unavailable", "usage-unsupported"]) {
    expect(
      await readCodexUsage(directory, { command: [process.execPath, fixture, flag] }),
    ).toBeNull();
  }
});

test("fails clearly when the Codex usage request times out", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-usage-"));
  await expect(
    readCodexUsage(directory, {
      command: [process.execPath, fixture, "usage-timeout"],
      timeoutMs: 20,
    }),
  ).rejects.toThrow("Codex usage request timed out");
});
