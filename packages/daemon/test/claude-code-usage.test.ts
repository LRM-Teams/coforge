import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClaudeCodeUsage } from "../src/code-agent/claude-code/usage";

const fixture = new URL("./fixtures/claude-usage.ts", import.meta.url).pathname;
const directory = () => mkdtemp(join(tmpdir(), "coforge-claude-usage-"));
const command = (mode?: string) => [process.execPath, fixture, ...(mode ? [mode] : [])];

test("reads Claude Code session and week usage windows", async () => {
  const result = await readClaudeCodeUsage(await directory(), { command: command() });
  expect(result?.provider).toBe("claude-code");
  expect(result?.primary?.usedPercent).toBe(25);
  expect(result?.primary?.resetsAt).toBe("2027-01-02T15:00:00.000Z");
  expect(result?.secondary?.usedPercent).toBe(75);
  expect(result?.secondary?.resetsAt).toBe("2027-01-05T00:00:00.000Z");
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
