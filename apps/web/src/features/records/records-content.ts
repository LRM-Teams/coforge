/** Weekly-report body: named display pages with one rich-text document per page. */

export type ReportTab = {
  markdown: string;
};

/** Leader-assignment inbox state stored in content JSON (no schema column yet). */
export type ReportAssignmentMeta = {
  unread: boolean;
};

/** Auto-send cancel for one ISO week, stored on the live format document. */
export type ReportScheduleMeta = {
  cancelledYear: number;
  cancelledWeek: number;
};

export type HighlightPromptHistoryEntry = {
  text: string;
  updatedAt: string;
};

/** Leader extraction prompt for 要点模板 (format document content JSON). */
export type HighlightPromptState = {
  text: string;
  /** When the current `text` was last saved; used as history stamp when superseded. */
  updatedAt?: string;
  history: HighlightPromptHistoryEntry[];
};

export const HIGHLIGHT_PROMPT_HISTORY_LIMIT = 20;

export type ReportContent = {
  tabs?: Record<string, ReportTab>;
  /** Temporary compatibility field used by the Notes draft cache. */
  markdown?: string;
  assignment?: ReportAssignmentMeta;
  schedule?: ReportScheduleMeta;
  highlightPrompt?: HighlightPromptState;
};

export type HighlightSource = {
  reportId: string;
  userId: string;
  displayName: string;
};

export type HighlightItem = {
  text: string;
  sources: HighlightSource[];
};

export type HighlightBlock = {
  id: string;
  heading: string;
  paragraphs: string[];
  items: HighlightItem[];
};

export type HighlightContent = {
  blocks: HighlightBlock[];
  generating?: boolean;
};

export const HIGHLIGHT_PROGRESS_HEADING = "一、本周进展";
export const HIGHLIGHT_PLAN_HEADING = "二、下周计划";

type LegacyOutlineNode = {
  text?: unknown;
  children?: LegacyOutlineNode[];
};

type LegacySection = {
  title?: unknown;
  markdown?: unknown;
  roots?: LegacyOutlineNode[];
};

function newTabName() {
  return "Summary";
}

function parseAssignmentMeta(value: unknown): ReportAssignmentMeta | undefined {
  if (!value || typeof value !== "object") return undefined;
  const unread = (value as { unread?: unknown }).unread;
  if (typeof unread !== "boolean") return undefined;
  return { unread };
}

function parseScheduleMeta(value: unknown): ReportScheduleMeta | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as { cancelledYear?: unknown; cancelledWeek?: unknown };
  if (typeof row.cancelledYear !== "number" || typeof row.cancelledWeek !== "number") {
    return undefined;
  }
  if (!Number.isInteger(row.cancelledYear) || !Number.isInteger(row.cancelledWeek)) {
    return undefined;
  }
  return { cancelledYear: row.cancelledYear, cancelledWeek: row.cancelledWeek };
}

function parseHighlightPrompt(value: unknown): HighlightPromptState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as { text?: unknown; updatedAt?: unknown; history?: unknown };
  const text = typeof row.text === "string" ? row.text : "";
  const updatedAt = typeof row.updatedAt === "string" ? row.updatedAt : undefined;
  const history = Array.isArray(row.history)
    ? row.history
        .map((entry) => {
          if (!entry || typeof entry !== "object") return null;
          const item = entry as { text?: unknown; updatedAt?: unknown };
          if (typeof item.text !== "string" || typeof item.updatedAt !== "string") return null;
          return { text: item.text, updatedAt: item.updatedAt };
        })
        .filter((entry): entry is HighlightPromptHistoryEntry => entry !== null)
    : [];
  return updatedAt ? { text, updatedAt, history } : { text, history };
}

function withOptionalMeta(
  content: ReportContent,
  assignment: ReportAssignmentMeta | undefined,
  schedule: ReportScheduleMeta | undefined,
  highlightPrompt?: HighlightPromptState | undefined,
): ReportContent {
  return {
    ...content,
    ...(assignment ? { assignment } : {}),
    ...(schedule ? { schedule } : {}),
    ...(highlightPrompt ? { highlightPrompt } : {}),
  };
}

function withOptionalAssignment(
  content: ReportContent,
  assignment: ReportAssignmentMeta | undefined,
): ReportContent {
  return withOptionalMeta(content, assignment, content.schedule, content.highlightPrompt);
}

function legacyOutlineToMarkdown(nodes: LegacyOutlineNode[], depth = 0): string {
  return nodes
    .flatMap((node) => {
      const text = typeof node.text === "string" ? node.text.trimEnd() : "";
      const line = text || (node.children?.length ?? 0) > 0 ? `${"  ".repeat(depth)}- ${text}` : "";
      const children = node.children?.length
        ? legacyOutlineToMarkdown(node.children, depth + 1)
        : "";
      return [line, children].filter(Boolean);
    })
    .join("\n");
}

function legacySectionsToMarkdown(sections: LegacySection[]): string {
  return sections
    .flatMap((section) => {
      const title = typeof section.title === "string" ? section.title.trim() : "";
      const body =
        typeof section.markdown === "string" && section.markdown.length > 0
          ? section.markdown
          : legacyOutlineToMarkdown(section.roots ?? []);
      return [title ? `## ${title}` : "", body].filter(Boolean);
    })
    .join("\n\n")
    .trim();
}

/** Create a blank report with one page when no template pages have been configured. */
export function emptyReportContent(dimensions: string[] = []): ReportContent {
  const names = dimensions.map((name) => name.trim()).filter(Boolean);
  const uniqueNames = [...new Set(names.length > 0 ? names : [newTabName()])];
  return {
    tabs: Object.fromEntries(uniqueNames.map((name) => [name, { markdown: "" }])),
  };
}

/** Keep page content while applying a template's current page names. */
export function alignReportContentToTemplate(
  content: ReportContent,
  dimensions: string[],
): ReportContent {
  const normalized = normalizeReportContent(content);
  const next = emptyReportContent(dimensions);
  const normalizedTabs = normalized.tabs ?? {};
  for (const name of Object.keys(next.tabs ?? {})) {
    next.tabs![name] = normalizedTabs[name] ?? { markdown: "" };
  }
  return withOptionalMeta(
    next,
    normalized.assignment,
    normalized.schedule,
    normalized.highlightPrompt,
  );
}

/** Clear every display page without removing the page structure. */
export function clearReportContent(content: ReportContent): ReportContent {
  const normalized = normalizeReportContent(content);
  return withOptionalMeta(
    {
      tabs: Object.fromEntries(
        Object.keys(normalized.tabs ?? {}).map((name) => [name, { markdown: "" }]),
      ),
    },
    normalized.assignment,
    normalized.schedule,
    normalized.highlightPrompt,
  );
}

/** Normalize persisted JSON, including the former single-markdown representation. */
export function normalizeReportContent(value: unknown): ReportContent {
  if (!value || typeof value !== "object") return emptyReportContent();
  const record = value as {
    markdown?: unknown;
    tabs?: Record<string, { markdown?: unknown; sections?: LegacySection[] }>;
    assignment?: unknown;
    schedule?: unknown;
    highlightPrompt?: unknown;
  };
  const assignment = parseAssignmentMeta(record.assignment);
  const schedule = parseScheduleMeta(record.schedule);
  const highlightPrompt = parseHighlightPrompt(record.highlightPrompt);

  if (record.tabs && typeof record.tabs === "object") {
    const tabs = Object.fromEntries(
      Object.entries(record.tabs).map(([name, tab]) => [
        name,
        {
          markdown:
            typeof tab?.markdown === "string"
              ? tab.markdown
              : legacySectionsToMarkdown(tab?.sections ?? []),
        },
      ]),
    );
    const base = Object.keys(tabs).length > 0 ? { tabs } : emptyReportContent();
    return withOptionalMeta(base, assignment, schedule, highlightPrompt);
  }

  if (typeof record.markdown === "string") {
    return withOptionalMeta(
      { tabs: { [newTabName()]: { markdown: record.markdown } } },
      assignment,
      schedule,
      highlightPrompt,
    );
  }
  return withOptionalMeta(emptyReportContent(), assignment, schedule, highlightPrompt);
}

export function isAssignmentUnread(content: ReportContent): boolean {
  return normalizeReportContent(content).assignment?.unread === true;
}

export function withAssignmentUnread(content: ReportContent, unread: boolean): ReportContent {
  return withOptionalAssignment(normalizeReportContent(content), { unread });
}

export function reportTabsEqual(left: ReportContent, right: ReportContent): boolean {
  const a = normalizeReportContent(left).tabs ?? {};
  const b = normalizeReportContent(right).tabs ?? {};
  return JSON.stringify(a) === JSON.stringify(b);
}

export function isAutoSendCancelled(content: ReportContent, year: number, week: number): boolean {
  const schedule = normalizeReportContent(content).schedule;
  return schedule?.cancelledYear === year && schedule?.cancelledWeek === week;
}

export function withAutoSendCancelled(
  content: ReportContent,
  year: number,
  week: number,
): ReportContent {
  const normalized = normalizeReportContent(content);
  return withOptionalMeta(
    normalized,
    normalized.assignment,
    {
      cancelledYear: year,
      cancelledWeek: week,
    },
    normalized.highlightPrompt,
  );
}

export function emptyHighlightPrompt(): HighlightPromptState {
  return { text: "", history: [] };
}

export function applyHighlightPromptText(
  current: HighlightPromptState | undefined,
  nextText: string,
  updatedAt: Date,
): HighlightPromptState {
  const previous = current ?? emptyHighlightPrompt();
  const text = nextText;
  const stamp = updatedAt.toISOString();
  if (previous.text === text) {
    return previous.updatedAt
      ? { text, updatedAt: previous.updatedAt, history: previous.history }
      : { text, updatedAt: stamp, history: previous.history };
  }
  const history =
    previous.text.trim().length > 0
      ? [
          {
            text: previous.text,
            updatedAt: previous.updatedAt ?? stamp,
          },
          ...previous.history,
        ].slice(0, HIGHLIGHT_PROMPT_HISTORY_LIMIT)
      : previous.history;
  return { text, updatedAt: stamp, history };
}

export function withHighlightPrompt(
  content: ReportContent,
  prompt: HighlightPromptState,
): ReportContent {
  const normalized = normalizeReportContent(content);
  return withOptionalMeta(normalized, normalized.assignment, normalized.schedule, prompt);
}

function parseHighlightSource(value: unknown): HighlightSource | null {
  if (!value || typeof value !== "object") return null;
  const row = value as { reportId?: unknown; userId?: unknown; displayName?: unknown };
  if (
    typeof row.reportId !== "string" ||
    typeof row.userId !== "string" ||
    typeof row.displayName !== "string"
  ) {
    return null;
  }
  return { reportId: row.reportId, userId: row.userId, displayName: row.displayName };
}

function parseHighlightItem(value: unknown): HighlightItem | null {
  if (typeof value === "string") {
    const text = value.trim();
    return text ? { text, sources: [] } : null;
  }
  if (!value || typeof value !== "object") return null;
  const row = value as { text?: unknown; sources?: unknown };
  if (typeof row.text !== "string") return null;
  const sources = Array.isArray(row.sources)
    ? row.sources
        .map(parseHighlightSource)
        .filter((source): source is HighlightSource => source !== null)
    : [];
  return { text: row.text, sources };
}

export function normalizeHighlightContent(value: unknown): HighlightContent {
  if (!value || typeof value !== "object") return emptyHighlightContent();
  const record = value as { blocks?: unknown; generating?: unknown };
  const generating = record.generating === true ? true : undefined;
  const blocks = Array.isArray(record.blocks)
    ? record.blocks.flatMap((block) => {
        if (!block || typeof block !== "object") return [];
        const row = block as {
          id?: unknown;
          heading?: unknown;
          paragraphs?: unknown;
          items?: unknown;
        };
        const heading = typeof row.heading === "string" ? row.heading : "";
        const id = typeof row.id === "string" && row.id.length > 0 ? row.id : heading || "block";
        const paragraphs = Array.isArray(row.paragraphs)
          ? row.paragraphs.filter((item): item is string => typeof item === "string")
          : [];
        const items = Array.isArray(row.items)
          ? row.items.map(parseHighlightItem).filter((item): item is HighlightItem => item !== null)
          : [];
        return [{ id, heading, paragraphs, items }];
      })
    : [];
  const content: HighlightContent = {
    blocks:
      blocks.length > 0
        ? blocks
        : [
            { id: "progress", heading: HIGHLIGHT_PROGRESS_HEADING, paragraphs: [], items: [] },
            { id: "plan", heading: HIGHLIGHT_PLAN_HEADING, paragraphs: [], items: [] },
          ],
  };
  return generating ? { ...content, generating: true } : content;
}

export function isHighlightGenerating(content: HighlightContent): boolean {
  return content.generating === true;
}

export function emptyHighlightContent(): HighlightContent {
  return {
    blocks: [
      { id: "progress", heading: HIGHLIGHT_PROGRESS_HEADING, paragraphs: [], items: [] },
      { id: "plan", heading: HIGHLIGHT_PLAN_HEADING, paragraphs: [], items: [] },
    ],
  };
}

export function generatingHighlightContent(): HighlightContent {
  return { ...emptyHighlightContent(), generating: true };
}

export function memberWeekTitle(year: number, week: number): string {
  return `${year} W${week} 工作周报`;
}

export function highlightTitle(year: number, week: number): string {
  return `${year} W${week} 周报要点`;
}

export function templateDraftTitle(year: number, week: number): string {
  return `${year} W${week} 周报模板`;
}

/** Member report title: `{name} {year} W{week} 工作周报`. */
export function memberReportTitle(displayName: string, year: number, week: number): string {
  return `${displayName} ${year} W${week} 工作周报`;
}

/** Markdown export of multi-tab report content. */
export function reportContentToMarkdown(content: ReportContent): string {
  const normalized = normalizeReportContent(content);
  const tabs = Object.entries(normalized.tabs ?? {});
  if (tabs.length === 0) return "";
  return tabs
    .map(([name, tab]) => {
      const body = tab.markdown.trim();
      return body.length > 0 ? `# ${name}\n\n${body}` : `# ${name}`;
    })
    .join("\n\n");
}

/** ISO week-year and week number for the given local calendar date. */
export function currentIsoWeek(date = new Date()): { year: number; week: number } {
  const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return { year: utc.getUTCFullYear(), week };
}

/** Rough name budget: up to 10 CJK chars or 20 Latin letters. */
export function isValidTemplateName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  let units = 0;
  let chinese = 0;
  let letters = 0;
  for (const char of trimmed) {
    if (/[\u4e00-\u9fff]/.test(char)) {
      chinese += 1;
      units += 2;
    } else if (/[A-Za-z]/.test(char)) {
      letters += 1;
      units += 1;
    } else {
      units += 1;
    }
  }
  return chinese <= 10 && letters <= 20 && units <= 20;
}

export function hourlySendTimes(): string[] {
  return Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, "0")}:00`);
}

export function isHourlySendTime(value: string): boolean {
  return /^([01]\d|2[0-3]):00$/.test(value);
}

/** Settings-table preview: first three names, then `...+N`. */
export function formatRecipientSummary(names: readonly string[]): string {
  if (names.length === 0) return "";
  const visible = names.slice(0, 3);
  const more = names.length - visible.length;
  const label = visible.join("，");
  return more > 0 ? `${label}...+${more}` : label;
}
