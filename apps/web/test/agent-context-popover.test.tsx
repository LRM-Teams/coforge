import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";

import { AgentContextPopoverContent } from "@/features/agents/agent-context-popover";
import { m } from "@/paraglide/messages";

type PopoverData = NonNullable<Parameters<typeof AgentContextPopoverContent>[0]["data"]>;

const report = {
  provider: "claude-code" as RuntimeProvider,
  model: "claude-haiku-4-5-20251001",
  usedTokens: 24_900,
  windowTokens: 200_000,
  observedAt: "2026-09-18T00:00:00.000Z",
  categories: [
    { name: "System prompt", tokens: 6_400 },
    { name: "System tools", tokens: 9_600 },
    { name: "Memory files", tokens: 151 },
    { name: "Free space", tokens: 175_100 },
  ],
  memoryFiles: [{ kind: "User", path: "/home/agent/.claude/CLAUDE.md", tokens: 151 }],
  skills: [
    { name: "find-docs", source: "User", tokens: 220 },
    { name: "init", source: "Built-in", tokens: 20, approximate: true },
  ],
};

const fresh = (overrides: Partial<NonNullable<PopoverData>["result"]> = {}): PopoverData => ({
  state: "fresh",
  result: {
    scanId: "scan-1",
    status: "available",
    report,
    collectedAt: "2026-09-18T00:00:00.000Z",
    ...overrides,
  },
});

test("renders the header, stacked bar, category table, and the two collapsible lists", () => {
  const markup = renderToStaticMarkup(
    <AgentContextPopoverContent
      data={fresh()}
      scanning={false}
      timeZone="UTC"
      onRefresh={() => {}}
    />,
  );
  expect(markup).toContain(m.agent_context_title());
  expect(markup).toContain("24,900");
  expect(markup).toContain("200,000");
  expect(markup).toContain("System prompt");
  expect(markup).toContain("Memory files");
  expect(markup).toContain("/home/agent/.claude/CLAUDE.md");
  expect(markup).toContain("find-docs");
  // Free space is drawn as the neutral remainder, never as a warning colour.
  expect(markup).toContain("Free space");
});

test("recomputes each category's share from its tokens and the window size", () => {
  const markup = renderToStaticMarkup(
    <AgentContextPopoverContent
      data={fresh()}
      scanning={false}
      timeZone="UTC"
      onRefresh={() => {}}
    />,
  );
  // 6_400 / 200_000 = 3.2% -> 3%; 175_100 / 200_000 = 87.55% -> 88%.
  expect(markup).toContain("3%");
  expect(markup).toContain("88%");
});

test("a reading with no report shows the failed state's reason inline, with a Refresh button", () => {
  for (const [status, expected] of [
    ["no_session", m.agent_context_status_no_session()],
    ["unsupported", m.agent_context_status_unsupported()],
    ["unparsed", m.agent_context_status_unparsed()],
    ["timeout", m.agent_context_status_timeout()],
    ["error", m.agent_context_status_error()],
  ] as const) {
    const markup = renderToStaticMarkup(
      <AgentContextPopoverContent
        data={fresh({ status, report: undefined })}
        scanning={false}
        timeZone="UTC"
        onRefresh={() => {}}
      />,
    );
    // renderToStaticMarkup escapes apostrophes; compare against the escaped form too.
    const escaped = expected.replaceAll("'", "&#x27;");
    expect(markup).toContain(escaped);
    expect(markup).toContain(m.agent_context_refresh());
  }
});

test("a missing reading shows the reading placeholder; a stale one shows the stale note", () => {
  const reading = renderToStaticMarkup(
    <AgentContextPopoverContent
      data={{ state: "missing", pendingScanId: "scan-2" }}
      scanning={false}
      timeZone="UTC"
      onRefresh={() => {}}
    />,
  );
  expect(reading).toContain(m.agent_context_reading());
  const stale = renderToStaticMarkup(
    <AgentContextPopoverContent
      data={{
        state: "stale",
        result: { ...fresh().result!, collectedAt: "2026-09-17T00:00:00.000Z" },
      }}
      scanning={false}
      timeZone="UTC"
      onRefresh={() => {}}
    />,
  );
  expect(stale).toContain(m.agent_context_stale());
});

test("the observed time and a Refresh button always close the popover body", () => {
  const markup = renderToStaticMarkup(
    <AgentContextPopoverContent
      data={fresh()}
      scanning={false}
      timeZone="UTC"
      onRefresh={() => {}}
    />,
  );
  expect(markup).toContain(m.agent_context_updated());
  expect(markup).toContain(m.agent_context_refresh());
});
