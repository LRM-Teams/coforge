import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { UsageUnavailableError, UsageUnsupportedError } from "../src/code-agent/contract";
import { readCodexUsage } from "../src/code-agent/codex/usage";

const fixture = new URL("./fixtures/codex-app-server.ts", import.meta.url).pathname;

/** Raft's window id: `w<index>_<first 12 hex of sha256(label)>`. */
function windowId(label: string, index: number): string {
  return `w${index}_${createHash("sha256").update(label).digest("hex").slice(0, 12)}`;
}

test("reads Codex account usage and converts rate-limit windows", async () => {
  const result = await readCodexUsage(await mkdtemp(join(tmpdir(), "coforge-usage-")), {
    command: [process.execPath, fixture, "usage"],
  });
  expect(result).toEqual({
    provider: "codex",
    planType: "plus",
    primary: {
      id: windowId("Codex · 5 hours", 0),
      usedPercent: 25,
      status: "ok",
      windowDurationMinutes: 300,
      resetsAt: "2025-01-02T01:20:00.000Z",
    },
    secondary: {
      id: windowId("Codex · 1 week", 1),
      usedPercent: 75,
      status: "ok",
      windowDurationMinutes: 10080,
      resetsAt: "2026-01-09T00:00:00.000Z",
    },
    accountLabel: "cod****er@example.com",
    health: "ok",
  });
  expect(JSON.stringify(result)).not.toContain("codexuser");
});

test("returns no snapshot when Codex is not logged in or does not support the method", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-usage-"));
  for (const flag of ["usage-unavailable", "usage-unsupported", "usage-auth"]) {
    expect(
      await readCodexUsage(directory, { command: [process.execPath, fixture, flag] }),
    ).toBeNull();
  }
});

test("answers unsupported for a non-subscription account", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-usage-"));
  for (const flag of ["usage-apikey", "usage-noauth"]) {
    await expect(
      readCodexUsage(directory, { command: [process.execPath, fixture, flag] }),
    ).rejects.toThrow(UsageUnsupportedError);
  }
});

test("scans an app-server that predates account/read, without the account label", async () => {
  const result = await readCodexUsage(await mkdtemp(join(tmpdir(), "coforge-usage-")), {
    command: [process.execPath, fixture, "usage-legacy"],
  });
  expect(result?.accountLabel).toBeUndefined();
  expect(result?.planType).toBe("plus");
  expect(result?.primary?.usedPercent).toBe(25);
  expect(result?.health).toBe("ok");
});

test("reports a limit-reached window and rate_limited account health", async () => {
  const result = await readCodexUsage(await mkdtemp(join(tmpdir(), "coforge-usage-")), {
    command: [process.execPath, fixture, "usage-ratelimited"],
  });
  expect(result?.primary?.status).toBe("limit_reached");
  expect(result?.primary?.usedPercent).toBe(100);
  expect(result?.health).toBe("rate_limited");
});

test("errors clearly when a signed-in account yields no usable window", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-usage-"));
  await expect(
    readCodexUsage(directory, { command: [process.execPath, fixture, "usage-empty"] }),
  ).rejects.toThrow(UsageUnavailableError);
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
