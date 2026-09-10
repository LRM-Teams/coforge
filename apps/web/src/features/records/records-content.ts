/** Structured weekly-report body: dimension tabs → outline sections. */

export type OutlineNode = {
  id: string;
  text: string;
  children: OutlineNode[];
};

export type ReportSection = {
  id: string;
  key: string;
  title: string;
  roots: OutlineNode[];
};

export type ReportTab = {
  sections: ReportSection[];
};

export type ReportContent = {
  tabs: Record<string, ReportTab>;
};

export type HighlightBlock = {
  id: string;
  heading: string;
  paragraphs: string[];
  items: string[];
};

export type HighlightContent = {
  blocks: HighlightBlock[];
};

function id() {
  return crypto.randomUUID();
}

function emptyOutlineRoot(): OutlineNode {
  return { id: id(), text: "", children: [] };
}

/** One tab body: sections come from template main titles (主要标题). */
export function emptyReportTab(mainTitles: string[] = []): ReportTab {
  const titles = mainTitles.map((title) => title.trim()).filter(Boolean);
  const sectionTitles = titles.length > 0 ? titles : [""];
  return {
    sections: sectionTitles.map((title, index) => ({
      id: id(),
      key: `section_${index}`,
      title,
      roots: [emptyOutlineRoot()],
    })),
  };
}

/**
 * Build report body from WeeklyReportTemplate shape.
 * `dimensions` → editor tabs; `mainTitles` → sections under each tab.
 */
export function emptyReportContent(
  dimensions: string[] = [],
  mainTitles: string[] = [],
): ReportContent {
  const tabs: Record<string, ReportTab> = {};
  for (const key of dimensions) {
    const name = key.trim();
    if (!name || tabs[name]) continue;
    tabs[name] = emptyReportTab(mainTitles);
  }
  return { tabs };
}

/** Keep matching tab bodies; drop tabs removed from dimensions; add missing ones. */
export function alignReportContentToTemplate(
  content: ReportContent,
  dimensions: string[],
  mainTitles: string[] = [],
): ReportContent {
  const normalized = normalizeReportContent(content);
  const tabs: Record<string, ReportTab> = {};
  for (const key of dimensions) {
    const name = key.trim();
    if (!name || tabs[name]) continue;
    tabs[name] = normalized.tabs[name] ?? emptyReportTab(mainTitles);
  }
  return { tabs };
}

/** Clear outline text while keeping tab and section structure. */
export function clearReportContent(content: ReportContent): ReportContent {
  const normalized = normalizeReportContent(content);
  const tabs: Record<string, ReportTab> = {};
  for (const [name, tab] of Object.entries(normalized.tabs)) {
    tabs[name] = {
      sections: tab.sections.map((section) => ({
        ...section,
        roots: [emptyOutlineRoot()],
      })),
    };
  }
  return { tabs };
}

/** Normalize persisted JSON into outline tabs. */
export function normalizeReportContent(value: unknown): ReportContent {
  if (!value || typeof value !== "object") return emptyReportContent();
  const record = value as {
    tabs?: Record<string, { sections?: ReportSection[] }>;
  };
  const tabs: Record<string, ReportTab> = {};
  for (const [name, tab] of Object.entries(record.tabs ?? {})) {
    if (!tab || !Array.isArray(tab.sections) || tab.sections.length === 0) {
      tabs[name] = emptyReportTab();
      continue;
    }
    tabs[name] = {
      sections: tab.sections.map((section) => ({
        id: section.id || id(),
        key: section.key || "section",
        title: section.title ?? "",
        roots:
          (section.roots?.length ?? 0) > 0 ? section.roots! : [emptyOutlineRoot()],
      })),
    };
  }
  return { tabs };
}

export function emptyHighlightContent(): HighlightContent {
  return {
    blocks: [
      { id: id(), heading: "本周工作进展", paragraphs: [], items: [] },
      { id: id(), heading: "下周计划", paragraphs: [], items: [] },
      { id: id(), heading: "要点总结", paragraphs: [], items: [] },
    ],
  };
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

export function memberReportTitle(displayName: string, year: number, week: number): string {
  return `${displayName} ${year} W${week} 工作周报`;
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
