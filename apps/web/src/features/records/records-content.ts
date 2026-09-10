/** Weekly-report body: one Markdown document (Notes-style). */

export type ReportContent = {
  markdown: string;
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

/** @deprecated Legacy outline node; only used when migrating old persisted JSON. */
type LegacyOutlineNode = {
  id?: string;
  text?: string;
  children?: LegacyOutlineNode[];
};

type LegacySection = {
  title?: string;
  markdown?: unknown;
  roots?: LegacyOutlineNode[];
};

function outlineNodesToMarkdown(nodes: LegacyOutlineNode[], depth = 0): string {
  const lines: string[] = [];
  for (const node of nodes) {
    const text = (node.text ?? "").trimEnd();
    const indent = "  ".repeat(depth);
    if (text.length > 0 || (node.children?.length ?? 0) > 0) {
      lines.push(`${indent}- ${text}`);
    }
    if (node.children?.length) {
      const nested = outlineNodesToMarkdown(node.children, depth + 1);
      if (nested) lines.push(nested);
    }
  }
  return lines.join("\n");
}

function sectionBody(section: LegacySection): string {
  if (typeof section.markdown === "string" && section.markdown.length > 0) {
    return section.markdown;
  }
  if (Array.isArray(section.roots) && section.roots.length > 0) {
    return outlineNodesToMarkdown(section.roots);
  }
  return "";
}

/** Flatten legacy tabs/sections into one Markdown document. */
function legacyTabsToMarkdown(tabs: Record<string, { sections?: LegacySection[] }>): string {
  const parts: string[] = [];
  for (const [tabName, tab] of Object.entries(tabs)) {
    const sections = tab?.sections ?? [];
    if (sections.length === 0) continue;
    const tabTrim = tabName.trim();
    if (tabTrim) parts.push(`# ${tabTrim}`);
    for (const section of sections) {
      const title = (section.title ?? "").trim();
      const body = sectionBody(section).trim();
      if (title) parts.push(`## ${title}`);
      if (body) parts.push(body);
    }
  }
  return parts.join("\n\n").trim();
}

/** Empty report document (template settings no longer shape the body). */
export function emptyReportContent(): ReportContent {
  return { markdown: "" };
}

/**
 * @deprecated Template dimensions no longer drive report body.
 * Kept as a no-op normalize for any remaining callers.
 */
export function alignReportContentToTemplate(content: ReportContent): ReportContent {
  return normalizeReportContent(content);
}

/** Clear the document body. */
export function clearReportContent(_content?: ReportContent): ReportContent {
  return { markdown: "" };
}

/** Normalize persisted JSON into a single markdown document. */
export function normalizeReportContent(value: unknown): ReportContent {
  if (!value || typeof value !== "object") return emptyReportContent();
  const record = value as {
    markdown?: unknown;
    tabs?: Record<string, { sections?: LegacySection[] }>;
  };
  if (typeof record.markdown === "string") {
    return { markdown: record.markdown };
  }
  if (record.tabs && typeof record.tabs === "object") {
    return { markdown: legacyTabsToMarkdown(record.tabs) };
  }
  return emptyReportContent();
}

export function emptyHighlightContent(): HighlightContent {
  return {
    blocks: [
      { id: crypto.randomUUID(), heading: "本周工作进展", paragraphs: [], items: [] },
      { id: crypto.randomUUID(), heading: "下周计划", paragraphs: [], items: [] },
      { id: crypto.randomUUID(), heading: "要点总结", paragraphs: [], items: [] },
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
