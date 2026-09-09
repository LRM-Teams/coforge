import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClaudeCodeUsage } from "../src/code-agent/claude-code/usage";

const fixture = new URL("./fixtures/claude-usage.ts", import.meta.url).pathname;
const directory = () => mkdtemp(join(tmpdir(), "coforge-claude-usage-"));
const command = (mode?: string) => [process.execPath, fixture, ...(mode ? [mode] : [])];

afterEach(() => setSystemTime());

test("preserves the scanner username for Claude credential lookup", async () => {
  const previousUser = Bun.env.USER;
  Bun.env.USER = "usage-test-user";
  try {
    const result = await readClaudeCodeUsage(await directory(), { command: command("username") });
    expect(result?.primary?.usedPercent).toBe(25);
  } finally {
    if (previousUser === undefined) delete Bun.env.USER;
    else Bun.env.USER = previousUser;
  }
});

test("reads current Claude usage with yearless reset dates from a non-UTC environment", async () => {
  setSystemTime(new Date("2026-09-09T06:13:00Z"));
  const result = await readClaudeCodeUsage(await directory(), {
    command: command("current"),
    environment: { TZ: "Asia/Shanghai" },
  });
  expect(result?.primary).toEqual({
    usedPercent: 6,
    resetsAt: "2026-09-09T06:29:00.000Z",
    windowDurationMinutes: 16,
  });
  expect(result?.secondary).toEqual({
    usedPercent: 0,
    resetsAt: "2026-09-16T04:59:00.000Z",
    windowDurationMinutes: 10006,
  });
});

test("reads Claude Code session and week usage windows", async () => {
  const result = await readClaudeCodeUsage(await directory(), { command: command() });
  expect(result?.provider).toBe("claude-code");
  expect(result?.primary?.usedPercent).toBe(25);
  expect(result?.primary?.resetsAt).toBe("2027-01-02T15:00:00.000Z");
  expect(result?.secondary?.usedPercent).toBe(75);
  expect(result?.secondary?.resetsAt).toBe("2027-01-05T00:00:00.000Z");
});

test.each([
  ["2026-12-31T23:00:00Z", "Jan 2 at 3:00pm", "2027-01-02T15:00:00.000Z"],
  ["2027-01-01T00:00:00Z", "Dec 31 at 11:59pm", "2026-12-31T23:59:00.000Z"],
  ["2026-09-09T06:30:00Z", "Sep 9 at 6:29am", "2026-09-09T06:29:00.000Z"],
])("resolves a yearless reset near the scan time %s", async (now, reset, expected) => {
  setSystemTime(new Date(now));
  const result = await readClaudeCodeUsage(await directory(), {
    command: command(),
    environment: { CLAUDE_USAGE_REPORT: `Current session: 6% used · resets ${reset} (UTC)` },
  });
  expect(result?.primary?.resetsAt).toBe(expected);
});

test("keeps session, all-model week, and model-specific limits separate", async () => {
  setSystemTime(new Date("2026-09-09T06:13:00Z"));
  const result = await readClaudeCodeUsage(await directory(), {
    command: command(),
    environment: {
      CLAUDE_USAGE_REPORT:
        "Current session: 6% used · resets unavailable\nCurrent week (Fable): 1% used · resets Sep 16 at 4:59am (UTC)\nCurrent week (all models): 20% used · resets Sep 16 at 4:59am (UTC)",
    },
  });
  expect(result?.primary).toBeUndefined();
  expect(result?.secondary?.usedPercent).toBe(20);
});

test("returns null when Claude Code is not logged in or usage cannot be parsed", async () => {
  expect(
    await readClaudeCodeUsage(await directory(), { command: command("logged-out") }),
  ).toBeNull();
  expect(
    await readClaudeCodeUsage(await directory(), { command: command("parse-failure") }),
  ).toBeNull();
});

test("times out and terminates Claude Code usage commands", async () => {
  await expect(
    readClaudeCodeUsage(await directory(), { command: command("timeout"), timeoutMs: 20 }),
  ).rejects.toThrow("Claude Code usage request timed out");
});
