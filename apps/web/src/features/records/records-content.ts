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

export type KeyPointPromptHistoryEntry = {
  text: string;
  updatedAt: string;
};

/** One prompt slot (team or personal) with history (ADR 0013 shape). */
export type KeyPointPromptState = {
  text: string;
  updatedAt?: string;
  history: KeyPointPromptHistoryEntry[];
};

/** Leader-owned prompts on live format documents (`kind=template`). */
export type KeyPointPromptsMeta = {
  team: KeyPointPromptState;
  personal: KeyPointPromptState;
};

export type KeyPointExtractionStatus =
  | "generating"
  | "ready"
  | "failed"
  | "pending_setup";

/** Personal key-point extraction result on a member report (Leader-only UI tab). */
export type KeyPointExtractionMeta = {
  status: KeyPointExtractionStatus;
  promptSnapshot: string;
  markdown?: string;
  generatedAt?: string;
  error?: string;
};

export const KEY_POINT_PROMPT_HISTORY_LIMIT = 20;

export const DEFAULT_TEAM_KEY_POINT_PROMPT = [
  "请基于本周全组成员已提交的周报，提炼一份团队要点纪要。要求：",
  "1、按「本周进展、下周计划、要点总结」三部分组织，使用 Markdown 标题与条目列表；",
  "2、优先保留可核对的事实：完成事项、阻塞风险、关键结论与明确计划，避免空泛表述；",
  "3、合并重复信息，按主题归类；同一事项可标注涉及成员姓名；",
  "4、语言简洁、描述清晰，少用过重的专业黑话；不确定处写「待确认」而非臆测；",
  "5、不要复述整篇周报原文，只输出提炼后的要点正文。",
].join("\n");

export const DEFAULT_PERSONAL_KEY_POINT_PROMPT = [
  "请阅读该成员本周已提交的周报全文，提炼个人要点。要求：",
  "1、按「本周进展、下周计划、要点总结」三部分组织，使用 Markdown 标题与条目列表；",
  "2、本周进展：列出已完成或推进中的关键事项，突出结果与影响；",
  "3、下周计划：列出明确计划与优先级，标出依赖或风险（如有）；",
  "4、要点总结：用 2–5 条概括本周核心信息，便于 Leader 快速扫读；",
  "5、语言简洁、描述清晰，少用过重的专业黑话；不要臆造周报中未出现的内容；",
  "6、只输出提炼后的 Markdown 正文，不要解释你的思考过程。",
].join("\n");

export type ReportContent = {
  tabs?: Record<string, ReportTab>;
  /** Temporary compatibility field used by the Notes draft cache. */
  markdown?: string;
  assignment?: ReportAssignmentMeta;
  schedule?: ReportScheduleMeta;
  /** Live format only: team + personal extraction prompts. */
  keyPointPrompts?: KeyPointPromptsMeta;
  /** Member report only: personal extraction run state + markdown. */
  keyPointExtraction?: KeyPointExtractionMeta;
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
  keyPointPrompts?: KeyPointPromptsMeta | undefined,
  keyPointExtraction?: KeyPointExtractionMeta | undefined,
): ReportContent {
  return {
    ...content,
    ...(assignment ? { assignment } : {}),
    ...(schedule ? { schedule } : {}),
    ...(keyPointPrompts ? { keyPointPrompts } : {}),
    ...(keyPointExtraction ? { keyPointExtraction } : {}),
  };
}

function withOptionalAssignment(
  content: ReportContent,
  assignment: ReportAssignmentMeta | undefined,
): ReportContent {
  return withOptionalMeta(
    content,
    assignment,
    content.schedule,
    content.keyPointPrompts,
    content.keyPointExtraction,
  );
}

function parseKeyPointPromptState(value: unknown): KeyPointPromptState | undefined {
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
        .filter((entry): entry is KeyPointPromptHistoryEntry => entry !== null)
    : [];
  return updatedAt ? { text, updatedAt, history } : { text, history };
}

function parseKeyPointPrompts(value: unknown): KeyPointPromptsMeta | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as { team?: unknown; personal?: unknown };
  const team = parseKeyPointPromptState(row.team);
  const personal = parseKeyPointPromptState(row.personal);
  if (!team && !personal) return undefined;
  return {
    team: team ?? emptyKeyPointPrompt(DEFAULT_TEAM_KEY_POINT_PROMPT),
    personal: personal ?? emptyKeyPointPrompt(DEFAULT_PERSONAL_KEY_POINT_PROMPT),
  };
}

const EXTRACTION_STATUSES = new Set<string>([
  "generating",
  "ready",
  "failed",
  "pending_setup",
]);

function parseKeyPointExtraction(value: unknown): KeyPointExtractionMeta | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as {
    status?: unknown;
    promptSnapshot?: unknown;
    markdown?: unknown;
    generatedAt?: unknown;
    error?: unknown;
  };
  if (typeof row.status !== "string" || !EXTRACTION_STATUSES.has(row.status)) return undefined;
  if (typeof row.promptSnapshot !== "string") return undefined;
  return {
    status: row.status as KeyPointExtractionStatus,
    promptSnapshot: row.promptSnapshot,
    ...(typeof row.markdown === "string" ? { markdown: row.markdown } : {}),
    ...(typeof row.generatedAt === "string" ? { generatedAt: row.generatedAt } : {}),
    ...(typeof row.error === "string" ? { error: row.error } : {}),
  };
}

export function emptyKeyPointPrompt(text = ""): KeyPointPromptState {
  return { text, history: [] };
}

export function emptyKeyPointPrompts(): KeyPointPromptsMeta {
  return {
    team: emptyKeyPointPrompt(DEFAULT_TEAM_KEY_POINT_PROMPT),
    personal: emptyKeyPointPrompt(DEFAULT_PERSONAL_KEY_POINT_PROMPT),
  };
}

/** Save a prompt slot: push previous non-empty text onto history when it changes. */
export function applyKeyPointPromptText(
  current: KeyPointPromptState | undefined,
  nextText: string,
  updatedAt: Date,
): KeyPointPromptState {
  const previous = current ?? emptyKeyPointPrompt();
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
        ].slice(0, KEY_POINT_PROMPT_HISTORY_LIMIT)
      : previous.history;
  return { text, updatedAt: stamp, history };
}

/** Remove one history entry by index (settings「删除」). */
export function removeKeyPointPromptHistoryEntry(
  current: KeyPointPromptState,
  historyIndex: number,
): KeyPointPromptState {
  if (historyIndex < 0 || historyIndex >= current.history.length) return current;
  return {
    ...current,
    history: current.history.filter((_, index) => index !== historyIndex),
  };
}

export function withKeyPointPrompts(
  content: ReportContent,
  prompts: KeyPointPromptsMeta,
): ReportContent {
  const normalized = normalizeReportContent(content);
  return withOptionalMeta(
    normalized,
    normalized.assignment,
    normalized.schedule,
    prompts,
    normalized.keyPointExtraction,
  );
}

export function withKeyPointExtraction(
  content: ReportContent,
  extraction: KeyPointExtractionMeta,
): ReportContent {
  const normalized = normalizeReportContent(content);
  return withOptionalMeta(
    normalized,
    normalized.assignment,
    normalized.schedule,
    normalized.keyPointPrompts,
    extraction,
  );
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
    normalized.keyPointPrompts,
    normalized.keyPointExtraction,
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
    normalized.keyPointPrompts,
    normalized.keyPointExtraction,
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
    keyPointPrompts?: unknown;
    keyPointExtraction?: unknown;
  };
  const assignment = parseAssignmentMeta(record.assignment);
  const schedule = parseScheduleMeta(record.schedule);
  const keyPointPrompts = parseKeyPointPrompts(record.keyPointPrompts);
  const keyPointExtraction = parseKeyPointExtraction(record.keyPointExtraction);

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
    return withOptionalMeta(base, assignment, schedule, keyPointPrompts, keyPointExtraction);
  }

  if (typeof record.markdown === "string") {
    return withOptionalMeta(
      { tabs: { [newTabName()]: { markdown: record.markdown } } },
      assignment,
      schedule,
      keyPointPrompts,
      keyPointExtraction,
    );
  }
  return withOptionalMeta(
    emptyReportContent(),
    assignment,
    schedule,
    keyPointPrompts,
    keyPointExtraction,
  );
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
    normalized.keyPointPrompts,
    normalized.keyPointExtraction,
  );
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
