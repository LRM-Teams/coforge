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

export type Level2Block = {
  title: string;
  body: string;
};

function tabHasLevel1Heading(markdown: string): boolean {
  return parseOutline(markdown).some((node) => node.kind === "heading" && node.level === 1);
}

function level2TitlesFromMarkdown(markdown: string): string[] {
  return parseOutline(markdown)
    .filter((node): node is Extract<OutlineNode, { kind: "heading" }> => {
      return node.kind === "heading" && node.level === 2;
    })
    .map((node) => node.text);
}

function markdownFromLevel2Titles(titles: string[]): string {
  const nodes: OutlineNode[] = [];
  let id = 0;
  for (const title of titles) {
    const text = trimTitle(title);
    if (!text) continue;
    nodes.push({ id: id++, kind: "heading", level: 2, text });
  }
  return serializeOutline(nodes);
}

function reportContentFromCombinedMarkdown(markdown: string): ReportContent {
  const tabs: Record<string, OutlineNode[]> = {};
  let current: string | null = null;
  for (const node of parseOutline(markdown)) {
    if (node.kind === "heading" && node.level === 1) {
      current = trimTitle(node.text) || "Summary";
      if (!tabs[current]) tabs[current] = [];
      continue;
    }
    if (!current) {
      current = "Summary";
      tabs[current] = [];
    }
    tabs[current]!.push(node);
  }
  const names = Object.keys(tabs);
  if (names.length === 0) return emptyReportContent();
  return {
    tabs: Object.fromEntries(
      names.map((name) => [name, { markdown: serializeOutline(tabs[name] ?? []) }]),
    ),
  };
}

function withAssignment(content: ReportContent, source: ReportContent): ReportContent {
  return {
    ...content,
    ...(source.assignment ? { assignment: source.assignment } : {}),
    ...(source.schedule ? { schedule: source.schedule } : {}),
    ...(source.highlightPrompt ? { highlightPrompt: source.highlightPrompt } : {}),
  };
}

function leadingBodyAndBlocks(markdown: string): { leading: string; blocks: Level2Block[] } {
  const leadingLines: string[] = [];
  const blocks: Level2Block[] = [];
  let seenLevel2 = false;
  let current: Level2Block | null = null;
  for (const node of parseOutline(markdown)) {
    if (node.kind === "heading" && node.level === 1) continue;
    if (node.kind === "heading" && node.level === 2) {
      seenLevel2 = true;
      current = { title: node.text, body: "" };
      blocks.push(current);
      continue;
    }
    if (node.kind !== "body") continue;
    if (!seenLevel2) {
      leadingLines.push(node.text);
      continue;
    }
    if (!current) continue;
    current.body = current.body.length > 0 ? `${current.body}\n${node.text}` : node.text;
  }
  return { leading: leadingLines.join("\n"), blocks };
}

function joinTabMarkdown(leading: string, blocks: Level2Block[]): string {
  const body = serializeLevel2Blocks(blocks);
  if (!leading) return body;
  if (!body) return leading;
  return `${leading}\n${body}`;
}

export function parseLevel2Blocks(markdown: string): Level2Block[] {
  return leadingBodyAndBlocks(markdown).blocks;
}

export function serializeLevel2Blocks(blocks: Level2Block[]): string {
  const nodes: OutlineNode[] = [];
  let id = 0;
  for (const block of blocks) {
    const title = trimTitle(block.title) || block.title;
    nodes.push({ id: id++, kind: "heading", level: 2, text: title });
    if (block.body.length === 0) continue;
    for (const line of block.body.split("\n")) {
      nodes.push({ id: id++, kind: "body", text: line });
    }
  }
  return serializeOutline(nodes);
}

/** Tabs are first-level titles; each tab's markdown holds only second-level headings. */
export function reportContentFromSections(sections: TemplateOutlineSection[]): ReportContent {
  if (sections.length === 0) return emptyReportContent();
  return {
    tabs: Object.fromEntries(
      sections.map((section) => [
        section.title,
        { markdown: markdownFromLevel2Titles(section.children) },
      ]),
    ),
  };
}

export function sectionsFromReportContent(content: ReportContent): TemplateOutlineSection[] {
  const normalized = normalizeReportContent(content);
  const tabs = normalized.tabs ?? {};
  const names = Object.keys(tabs);
  const firstMarkdown = names[0] ? (tabs[names[0]]?.markdown ?? "") : (normalized.markdown ?? "");
  if (names.length === 1 && tabHasLevel1Heading(firstMarkdown)) {
    return markdownToSections(firstMarkdown);
  }
  return names.map((title) => ({
    title,
    children: level2TitlesFromMarkdown(tabs[title]?.markdown ?? ""),
  }));
}

/** Split a legacy single-tab H1 document so the editor can treat tabs as level-1 titles. */
export function normalizeLeaderFormatTabs(content: ReportContent): ReportContent {
  const normalized = normalizeReportContent(content);
  const tabs = normalized.tabs ?? {};
  const names = Object.keys(tabs);
  const firstMarkdown = names[0] ? (tabs[names[0]]?.markdown ?? "") : "";
  if (names.length === 1 && tabHasLevel1Heading(firstMarkdown)) {
    return withAssignment(reportContentFromCombinedMarkdown(firstMarkdown), normalized);
  }
  return normalized;
}

export function alignReportContentToSections(
  content: ReportContent,
  sections: TemplateOutlineSection[],
): ReportContent {
  const normalized = normalizeLeaderFormatTabs(content);
  if (sections.length === 0) return normalized;
  const tabs: Record<string, { markdown: string }> = {};
  for (const section of sections) {
    const existing = leadingBodyAndBlocks(normalized.tabs?.[section.title]?.markdown ?? "");
    const byTitle = new Map(existing.blocks.map((block) => [block.title, block]));
    const blocks = section.children.map((title) => byTitle.get(title) ?? { title, body: "" });
    tabs[section.title] = { markdown: joinTabMarkdown(existing.leading, blocks) };
  }
  return withAssignment({ tabs }, normalized);
}
