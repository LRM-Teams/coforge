import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parseClaudeContextReport } from "../src/code-agent/claude-code/context-report";

const FIXTURE_PATH = new URL("./fixtures/claude-context-report.md", import.meta.url).pathname;
const fixture = () => readFile(FIXTURE_PATH, "utf8");

test("parses the full report: header, category table, memory files, and skills", async () => {
  const report = parseClaudeContextReport(await fixture(), "2026-09-18T00:00:00.000Z");
  expect(report).toEqual({
    provider: "claude-code",
    model: "claude-haiku-4-5-20251001",
    usedTokens: 24_900,
    windowTokens: 200_000,
    observedAt: "2026-09-18T00:00:00.000Z",
    categories: [
      { name: "System prompt", tokens: 6_400 },
      { name: "System tools", tokens: 9_600 },
      { name: "System tools (deferred)", tokens: 16_300 },
      { name: "Memory files", tokens: 151 },
      { name: "Skills", tokens: 2_000 },
      { name: "Messages", tokens: 6_700 },
      { name: "Free space", tokens: 175_100 },
    ],
    memoryFiles: [{ kind: "User", path: "/home/agent/.claude/CLAUDE.md", tokens: 151 }],
    skills: [
      { name: "find-docs", source: "User", tokens: 220 },
      { name: "dataviz", source: "Built-in", tokens: 360 },
      { name: "init", source: "Built-in", tokens: 20, approximate: true },
    ],
  });
});

test("defaults observedAt to the current time when not given one", async () => {
  const before = Date.now();
  const report = parseClaudeContextReport(await fixture());
  expect(report).toBeDefined();
  expect(Date.parse(report!.observedAt)).toBeGreaterThanOrEqual(before);
});

test("tolerates an unknown trailing section and an unrecognized extra column", () => {
  const markdown = `## Context Usage

**Tokens:** 1k / 10k (10%)

### Estimated usage by category

| Category | Tokens | Percentage | Notes |
|----------|--------|------------|-------|
| System prompt | 1k | 10% | future field |

### Something New

| Field | Value |
|-------|-------|
| Unrelated | data |
`;
  const report = parseClaudeContextReport(markdown, "2026-09-18T00:00:00.000Z");
  expect(report).toEqual({
    provider: "claude-code",
    usedTokens: 1_000,
    windowTokens: 10_000,
    observedAt: "2026-09-18T00:00:00.000Z",
    categories: [{ name: "System prompt", tokens: 1_000 }],
  });
});

test("returns undefined for garbage input", () => {
  expect(parseClaudeContextReport("not a context report at all")).toBeUndefined();
  expect(parseClaudeContextReport("")).toBeUndefined();
  expect(parseClaudeContextReport("**Tokens:** garbage / nonsense")).toBeUndefined();
});

test("returns undefined when the header is present but no category table follows", () => {
  expect(parseClaudeContextReport("**Tokens:** 1k / 10k (10%)\n\nno table here")).toBeUndefined();
});
