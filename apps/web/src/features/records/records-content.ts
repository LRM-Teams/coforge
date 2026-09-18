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

export type ReportContent = {
  tabs?: Record<string, ReportTab>;
  /** Temporary compatibility field used by the Notes draft cache. */
  markdown?: string;
  assignment?: ReportAssignmentMeta;
  schedule?: ReportScheduleMeta;
};

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

function withOptionalMeta(
  content: ReportContent,
  assignment: ReportAssignmentMeta | undefined,
  schedule: ReportScheduleMeta | undefined,
): ReportContent {
  return {
    ...content,
    ...(assignment ? { assignment } : {}),
    ...(schedule ? { schedule } : {}),
  };
}

function withOptionalAssignment(
  content: ReportContent,
  assignment: ReportAssignmentMeta | undefined,
): ReportContent {
  return withOptionalMeta(content, assignment, content.schedule);
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
  return withOptionalMeta(next, normalized.assignment, normalized.schedule);
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
  };
  const assignment = parseAssignmentMeta(record.assignment);
  const schedule = parseScheduleMeta(record.schedule);

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
    return withOptionalMeta(base, assignment, schedule);
  }

  if (typeof record.markdown === "string") {
    return withOptionalMeta(
      { tabs: { [newTabName()]: { markdown: record.markdown } } },
      assignment,
      schedule,
    );
  }
  return withOptionalMeta(emptyReportContent(), assignment, schedule);
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
  return withOptionalMeta(normalized, normalized.assignment, {
    cancelledYear: year,
    cancelledWeek: week,
  });
}

export function memberWeekTitle(year: number, week: number): string {
  return `${year} W${week} 工作周报`;
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
