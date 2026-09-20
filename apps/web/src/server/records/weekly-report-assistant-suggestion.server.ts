import type { ReportContent } from "../../features/records/records-content";

const OPEN = "[weekly-report-suggestion]";
const CLOSE = "[/weekly-report-suggestion]";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Real envelopes put JSON right after the open tag. Prose that merely mentions
 * `[weekly-report-suggestion]` (e.g. inside backticks) must not truncate the DM.
 */
function findSuggestionEnvelopeStart(body: string): number {
  let from = 0;
  while (from < body.length) {
    const start = body.indexOf(OPEN, from);
    if (start < 0) return -1;
    const after = body.slice(start + OPEN.length);
    if (/^\s*\{/.test(after)) return start;
    from = start + OPEN.length;
  }
  return -1;
}

export type WeeklyReportBodyEditSuggestion = {
  type: "body-edit";
  reportId: string;
  summary: string;
  content: ReportContent;
};

export type WeeklyReportKeyPointEditSuggestion = {
  type: "key-point-edit";
  reportId: string;
  summary: string;
  markdown: string;
};

export type WeeklyReportSendPromptSuggestion = {
  type: "send-prompt";
  reportId: string;
};

export type WeeklyReportAssistantSuggestion =
  | WeeklyReportBodyEditSuggestion
  | WeeklyReportKeyPointEditSuggestion
  | WeeklyReportSendPromptSuggestion;

/** Builds an Agent→User DM body that carries a confirmable write suggestion. */
export function buildWeeklyReportAssistantSuggestionBody(input: {
  displayText: string;
  suggestion: WeeklyReportAssistantSuggestion;
}): string {
  return [input.displayText.trim(), "", OPEN, JSON.stringify(input.suggestion), CLOSE].join("\n");
}

export function weeklyReportAssistantSuggestionDisplayBody(body: string): string {
  const start = findSuggestionEnvelopeStart(body);
  if (start < 0) return body.trim();
  return body.slice(0, start).trim();
}

export function parseWeeklyReportAssistantSuggestion(
  body: string,
): WeeklyReportAssistantSuggestion | null {
  const start = findSuggestionEnvelopeStart(body);
  if (start < 0) return null;
  const afterOpen = body.slice(start + OPEN.length).trimStart();
  const closeAt = afterOpen.indexOf(CLOSE);
  const candidate =
    closeAt >= 0 ? afterOpen.slice(0, closeAt).trim() : extractLeadingJsonObject(afterOpen);
  if (!candidate) return null;
  try {
    return normalizeSuggestion(JSON.parse(candidate) as unknown);
  } catch {
    return null;
  }
}

/** When the Agent omits `[/weekly-report-suggestion]`, take the first JSON object. */
function extractLeadingJsonObject(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return trimmed.slice(0, i + 1);
    }
  }
  return null;
}

function normalizeSuggestion(value: unknown): WeeklyReportAssistantSuggestion | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.type === "send-prompt") {
    return typeof row.reportId === "string" && UUID_RE.test(row.reportId)
      ? { type: "send-prompt", reportId: row.reportId }
      : null;
  }
  if (row.type === "key-point-edit") {
    if (typeof row.reportId !== "string" || !UUID_RE.test(row.reportId)) return null;
    if (typeof row.summary !== "string" || row.summary.trim().length === 0) return null;
    if (typeof row.markdown !== "string" || row.markdown.trim().length === 0) return null;
    return {
      type: "key-point-edit",
      reportId: row.reportId,
      summary: row.summary.trim(),
      markdown: row.markdown,
    };
  }
  if (row.type === "body-edit") {
    if (typeof row.reportId !== "string" || !UUID_RE.test(row.reportId)) return null;
    if (typeof row.summary !== "string" || row.summary.trim().length === 0) return null;
    const content = asReportContent(row.content);
    if (!content) return null;
    return {
      type: "body-edit",
      reportId: row.reportId,
      summary: row.summary.trim(),
      content,
    };
  }
  return null;
}

function asReportContent(value: unknown): ReportContent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const tabsValue = Reflect.get(value, "tabs");
  if (tabsValue === undefined) {
    const markdown = Reflect.get(value, "markdown");
    return typeof markdown === "string" ? { markdown } : { tabs: {} };
  }
  if (!tabsValue || typeof tabsValue !== "object" || Array.isArray(tabsValue)) return null;
  const tabs: NonNullable<ReportContent["tabs"]> = {};
  for (const [name, tab] of Object.entries(tabsValue)) {
    // Agents often emit `"Summary": "## ..."`; canonical form is `{ markdown }`.
    if (typeof tab === "string") {
      tabs[name] = { markdown: tab };
      continue;
    }
    if (!tab || typeof tab !== "object" || Array.isArray(tab)) return null;
    const markdown = Reflect.get(tab, "markdown");
    if (typeof markdown !== "string") return null;
    tabs[name] = { markdown };
  }
  return { tabs };
}
