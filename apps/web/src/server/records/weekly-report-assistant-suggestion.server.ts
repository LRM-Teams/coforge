import type { HighlightContent, ReportContent } from "../../features/records/records-content";

const OPEN = "[weekly-report-suggestion]";
const CLOSE = "[/weekly-report-suggestion]";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type WeeklyReportBodyEditSuggestion = {
  type: "body-edit";
  reportId: string;
  summary: string;
  content: ReportContent;
};

export type WeeklyReportHighlightSuggestion = {
  type: "highlight";
  cycleId: string;
  highlightId?: string;
  summary: string;
  content: HighlightContent;
  markCompleted?: boolean;
};

export type WeeklyReportSendPromptSuggestion = {
  type: "send-prompt";
  reportId: string;
};

export type WeeklyReportAssistantSuggestion =
  | WeeklyReportBodyEditSuggestion
  | WeeklyReportHighlightSuggestion
  | WeeklyReportSendPromptSuggestion;

/** Builds an Agent→User DM body that carries a confirmable write suggestion. */
export function buildWeeklyReportAssistantSuggestionBody(input: {
  displayText: string;
  suggestion: WeeklyReportAssistantSuggestion;
}): string {
  return [
    input.displayText.trim(),
    "",
    OPEN,
    JSON.stringify(input.suggestion),
    CLOSE,
  ].join("\n");
}

export function weeklyReportAssistantSuggestionDisplayBody(body: string): string {
  const start = body.indexOf(OPEN);
  if (start < 0) return body.trim();
  return body.slice(0, start).trim();
}

export function parseWeeklyReportAssistantSuggestion(
  body: string,
): WeeklyReportAssistantSuggestion | null {
  const start = body.indexOf(OPEN);
  const end = body.indexOf(CLOSE);
  if (start < 0 || end < 0 || end <= start) return null;
  const raw = body.slice(start + OPEN.length, end).trim();
  try {
    return normalizeSuggestion(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function normalizeSuggestion(value: unknown): WeeklyReportAssistantSuggestion | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.type === "send-prompt") {
    return typeof row.reportId === "string" && UUID_RE.test(row.reportId)
      ? { type: "send-prompt", reportId: row.reportId }
      : null;
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
  if (row.type === "highlight") {
    if (typeof row.cycleId !== "string" || !UUID_RE.test(row.cycleId)) return null;
    if (typeof row.summary !== "string" || row.summary.trim().length === 0) return null;
    const content = asHighlightContent(row.content);
    if (!content) return null;
    const highlightId =
      typeof row.highlightId === "string" && UUID_RE.test(row.highlightId)
        ? row.highlightId
        : undefined;
    return {
      type: "highlight",
      cycleId: row.cycleId,
      ...(highlightId ? { highlightId } : {}),
      summary: row.summary.trim(),
      content,
      ...(row.markCompleted === true ? { markCompleted: true } : {}),
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
    if (!tab || typeof tab !== "object" || Array.isArray(tab)) return null;
    const markdown = Reflect.get(tab, "markdown");
    if (typeof markdown !== "string") return null;
    tabs[name] = { markdown };
  }
  return { tabs };
}

function asHighlightContent(value: unknown): HighlightContent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const blocksValue = Reflect.get(value, "blocks");
  if (!Array.isArray(blocksValue)) return null;
  const blocks = [];
  for (const block of blocksValue) {
    if (!block || typeof block !== "object" || Array.isArray(block)) return null;
    const id = Reflect.get(block, "id");
    const heading = Reflect.get(block, "heading");
    const paragraphs = Reflect.get(block, "paragraphs");
    const items = Reflect.get(block, "items");
    if (typeof id !== "string" || typeof heading !== "string") return null;
    if (!Array.isArray(paragraphs) || !paragraphs.every((item) => typeof item === "string"))
      return null;
    if (!Array.isArray(items)) return null;
    const normalizedItems = [];
    for (const item of items) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const text = Reflect.get(item, "text");
      const sources = Reflect.get(item, "sources");
      if (typeof text !== "string" || !Array.isArray(sources)) return null;
      normalizedItems.push({ text, sources: sources as HighlightContent["blocks"][0]["items"][0]["sources"] });
    }
    blocks.push({ id, heading, paragraphs, items: normalizedItems });
  }
  return { blocks };
}
