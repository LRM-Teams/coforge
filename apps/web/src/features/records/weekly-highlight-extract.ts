import {
  HIGHLIGHT_PLAN_HEADING,
  HIGHLIGHT_PROGRESS_HEADING,
  type HighlightContent,
  type HighlightItem,
  type ReportContent,
} from "./records-content";

export type HighlightSourceReport = {
  reportId: string;
  userId: string;
  displayName: string;
  content: ReportContent;
};

export type HighlightMemberCandidate = {
  userId: string;
  displayName: string;
  submitted: boolean;
  reportId?: string;
};

export type RecordAssistantPayload =
  | { kind: "offer-generate"; members: HighlightMemberCandidate[] }
  | { kind: "pick-members"; members: HighlightMemberCandidate[] }
  | { kind: "offer-send" }
  | { kind: "generating"; highlightId: string }
  | { kind: "generated"; highlightId: string };

const MAX_ITEMS_PER_MEMBER_SECTION = 8;

export function parseRecordAssistantPayload(value: unknown): RecordAssistantPayload | null {
  if (!value || typeof value !== "object") return null;
  const row = value as { kind?: unknown; members?: unknown; highlightId?: unknown };
  if (row.kind === "offer-send") return { kind: "offer-send" };
  if (row.kind === "generating" && typeof row.highlightId === "string") {
    return { kind: "generating", highlightId: row.highlightId };
  }
  if (row.kind === "generated" && typeof row.highlightId === "string") {
    return { kind: "generated", highlightId: row.highlightId };
  }
  if (
    (row.kind === "offer-generate" || row.kind === "pick-members") &&
    Array.isArray(row.members)
  ) {
    const members = row.members.flatMap((member) => {
      if (!member || typeof member !== "object") return [];
      const item = member as {
        userId?: unknown;
        displayName?: unknown;
        submitted?: unknown;
        reportId?: unknown;
      };
      if (typeof item.userId !== "string" || typeof item.displayName !== "string") return [];
      return [
        {
          userId: item.userId,
          displayName: item.displayName,
          submitted: item.submitted === true,
          reportId: typeof item.reportId === "string" ? item.reportId : undefined,
        },
      ];
    });
    return row.kind === "offer-generate"
      ? { kind: "offer-generate", members }
      : { kind: "pick-members", members };
  }
  return null;
}

export function looksLikeGenerateHighlightsRequest(body: string): boolean {
  const text = body.trim();
  return /生成本周周报要点|生成要点|generate.*highlight/i.test(text);
}

function classifyTabName(name: string): "progress" | "plan" | "other" {
  if (/计划|plan/i.test(name)) return "plan";
  if (/进展|本周|工作|summary|progress/i.test(name)) return "progress";
  return "other";
}

function bulletsFromMarkdown(markdown: string): string[] {
  const items: string[] = [];
  for (const raw of markdown.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const text = trimmed.replace(/^[-*+]\s+/, "").replace(/^\d+\.\s+/, "");
    if (text.length > 0) items.push(text);
    if (items.length >= MAX_ITEMS_PER_MEMBER_SECTION) break;
  }
  return items;
}

function tabMarkdown(content: ReportContent): Array<{ name: string; markdown: string }> {
  return Object.entries(content.tabs ?? {}).map(([name, tab]) => ({
    name,
    markdown: tab.markdown,
  }));
}

function itemsForSection(
  report: HighlightSourceReport,
  section: "progress" | "plan",
): HighlightItem[] {
  const tabs = tabMarkdown(report.content);
  const matched = tabs.filter((tab) => classifyTabName(tab.name) === section);
  const fallback =
    matched.length > 0
      ? matched
      : section === "progress"
        ? tabs.filter((tab) => classifyTabName(tab.name) === "other")
        : [];
  const bullets = fallback.flatMap((tab) => bulletsFromMarkdown(tab.markdown));
  return bullets.map((text) => ({
    text,
    sources: [
      {
        reportId: report.reportId,
        userId: report.userId,
        displayName: report.displayName,
      },
    ],
  }));
}

/** Deterministic highlight body from submitted member reports (ADR 0014). */
export function extractWeeklyHighlightContent(
  reports: readonly HighlightSourceReport[],
): HighlightContent {
  const progress = reports.flatMap((report) => itemsForSection(report, "progress"));
  const plan = reports.flatMap((report) => itemsForSection(report, "plan"));
  return {
    blocks: [
      {
        id: "progress",
        heading: HIGHLIGHT_PROGRESS_HEADING,
        paragraphs: [],
        items: progress,
      },
      {
        id: "plan",
        heading: HIGHLIGHT_PLAN_HEADING,
        paragraphs: [],
        items: plan,
      },
    ],
  };
}
