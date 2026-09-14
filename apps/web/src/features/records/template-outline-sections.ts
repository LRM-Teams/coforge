import { parseOutline, serializeOutline, type OutlineNode } from "./report-template-outline";
import { emptyReportContent, normalizeReportContent, type ReportContent } from "./records-content";

/** Settings-dialog outline: one level-1 title with optional level-2 children. */
export type TemplateOutlineSection = {
  title: string;
  children: string[];
};

function trimTitle(value: string) {
  return value.trim();
}

/** Normalize Json from WeeklyReportTemplate.dimensions (legacy string[] or sections). */
export function parseTemplateSections(value: unknown): TemplateOutlineSection[] {
  if (!Array.isArray(value)) return [];
  if (value.length === 0) return [];
  if (typeof value[0] === "string") {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((title) => ({ title: trimTitle(title), children: [] }))
      .filter((section) => section.title.length > 0);
  }
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const row = item as { title?: unknown; children?: unknown };
      const title = typeof row.title === "string" ? trimTitle(row.title) : "";
      if (!title) return null;
      const children = Array.isArray(row.children)
        ? row.children
            .filter((child): child is string => typeof child === "string")
            .map(trimTitle)
            .filter(Boolean)
        : [];
      return { title, children };
    })
    .filter((section): section is TemplateOutlineSection => section !== null);
}

export function sectionsToMarkdown(sections: TemplateOutlineSection[]): string {
  const nodes: OutlineNode[] = [];
  let id = 0;
  for (const section of sections) {
    const title = trimTitle(section.title);
    if (!title) continue;
    nodes.push({ id: id++, kind: "heading", level: 1, text: title });
    for (const child of section.children) {
      const childTitle = trimTitle(child);
      if (!childTitle) continue;
      nodes.push({ id: id++, kind: "heading", level: 2, text: childTitle });
    }
  }
  return serializeOutline(nodes);
}

/** Extract only H1/H2 titles for the settings dialog (body / deeper headings ignored). */
export function markdownToSections(markdown: string): TemplateOutlineSection[] {
  const sections: TemplateOutlineSection[] = [];
  let current: TemplateOutlineSection | null = null;
  for (const node of parseOutline(markdown)) {
    if (node.kind !== "heading") continue;
    if (node.level === 1) {
      current = { title: node.text, children: [] };
      sections.push(current);
      continue;
    }
    if (node.level === 2 && current) {
      current.children.push(node.text);
    }
  }
  return sections;
}

function headingKey(level: number, text: string) {
  return `${level}:${text.trim()}`;
}

/**
 * Rebuild markdown from settings sections while preserving body lines that
 * already sit under a heading with the same level+title.
 */
export function alignMarkdownToSections(
  existingMarkdown: string,
  sections: TemplateOutlineSection[],
): string {
  const existing = parseOutline(existingMarkdown);
  const bodies = new Map<string, string[]>();
  let activeKey: string | null = null;
  for (const node of existing) {
    if (node.kind === "heading" && (node.level === 1 || node.level === 2)) {
      activeKey = headingKey(node.level, node.text);
      if (!bodies.has(activeKey)) bodies.set(activeKey, []);
      continue;
    }
    if (activeKey && node.kind === "body") {
      bodies.get(activeKey)!.push(node.text);
    }
  }

  const nodes: OutlineNode[] = [];
  let id = 0;
  function pushHeading(level: 1 | 2, text: string) {
    const title = trimTitle(text);
    if (!title) return;
    nodes.push({ id: id++, kind: "heading", level, text: title });
    const bodyLines = bodies.get(headingKey(level, title)) ?? [];
    for (const line of bodyLines) {
      nodes.push({ id: id++, kind: "body", text: line });
    }
  }

  for (const section of sections) {
    pushHeading(1, section.title);
    for (const child of section.children) pushHeading(2, child);
  }
  return serializeOutline(nodes);
}

export function reportContentFromSections(sections: TemplateOutlineSection[]): ReportContent {
  const markdown = sectionsToMarkdown(sections);
  return {
    tabs: {
      Summary: { markdown },
    },
  };
}

export function sectionsFromReportContent(content: ReportContent): TemplateOutlineSection[] {
  const normalized = normalizeReportContent(content);
  const tabs = normalized.tabs ?? {};
  const first = Object.values(tabs)[0];
  return markdownToSections(first?.markdown ?? normalized.markdown ?? "");
}

export function alignReportContentToSections(
  content: ReportContent,
  sections: TemplateOutlineSection[],
): ReportContent {
  const normalized = normalizeReportContent(content);
  const tabNames = Object.keys(normalized.tabs ?? {});
  const primary = tabNames[0] ?? "Summary";
  const current = normalized.tabs?.[primary]?.markdown ?? "";
  const nextMarkdown =
    sections.length === 0 ? current : alignMarkdownToSections(current, sections);
  const base = emptyReportContent([primary]);
  return {
    tabs: {
      ...base.tabs,
      [primary]: { markdown: nextMarkdown },
    },
    ...(normalized.assignment ? { assignment: normalized.assignment } : {}),
  };
}
