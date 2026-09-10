import { useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { DotsHorizontal, MessageChatCircle as Message, Trash01 as Trash } from "@untitledui/icons";

import { PageHeader } from "@/components/layout/page-header";
import { Avatar } from "@/components/ui/avatar";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";
import { saveWeeklyHighlightContent, saveWeeklyReportContent } from "./records.functions";
import {
  clearReportContent,
  emptyReportTab,
  normalizeReportContent,
  type HighlightContent,
  type OutlineNode,
  type ReportContent,
} from "./records-content";
import { BackToRecords } from "./records-layout";
import { RecordSidePanel } from "./record-side-panel";

type ReportSubject = {
  type: "report";
  report: {
    id: string;
    kind: string;
    title: string;
    status: string;
    content: ReportContent;
    author: { userId: string; username: string; displayName: string };
    cycle: { id: string; year: number; week: number; title: string };
  };
};

type HighlightSubject = {
  type: "highlight";
  highlight: {
    id: string;
    title: string;
    content: HighlightContent;
    completedAt: string | null;
    cycle: { id: string; year: number; week: number; title: string };
  };
};

export function RecordDetail({ subject }: { subject: ReportSubject | HighlightSubject }) {
  if (subject.type === "highlight") {
    return <HighlightDetail highlight={subject.highlight} />;
  }
  return <ReportDetail report={subject.report} />;
}

function ReportDetail({ report }: { report: ReportSubject["report"] }) {
  const save = useServerFn(saveWeeklyReportContent);
  const [content, setContent] = useState(() => normalizeReportContent(report.content));
  const contentRef = useRef(content);
  contentRef.current = content;
  const tabNames = Object.keys(content.tabs);
  const [selectedTab, setSelectedTab] = useState(tabNames[0] ?? "");
  const activeTab = tabNames.includes(selectedTab) ? selectedTab : (tabNames[0] ?? "");
  const [sideOpen, setSideOpen] = useState(true);
  const [saving, setSaving] = useState(false);

  async function persist(next: ReportContent, status?: "draft" | "submitted" | "shared") {
    setSaving(true);
    try {
      const normalized = normalizeReportContent(next);
      await save({ data: { reportId: report.id, content: normalized, status } });
      setContent(normalized);
      contentRef.current = normalized;
    } finally {
      setSaving(false);
    }
  }

  const tab = content.tabs[activeTab] ?? emptyReportTab();

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <PageHeader
          heading={report.title}
          leading={<BackToRecords />}
          meta={
            <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
              <Avatar people={[{ name: report.author.displayName }]} size="sm" />
              <span className="truncate">{report.author.displayName}</span>
            </div>
          }
          actions={
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={m.records_side_chat()}
                aria-pressed={sideOpen}
                onClick={() => setSideOpen((open) => !open)}
              >
                <Message aria-hidden="true" />
              </Button>
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger
                  aria-label={m.records_report_actions()}
                  className={buttonVariants({ variant: "ghost", size: "icon-xs" })}
                >
                  <DotsHorizontal aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={saving || tabNames.length === 0}
                    onClick={() => void persist(clearReportContent(contentRef.current), "draft")}
                  >
                    <Trash aria-hidden="true" />
                    {m.records_report_clear()}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          }
        />

        {tabNames.length === 0 ? (
          <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">
            {m.records_tabs_from_dimensions_empty()}
          </div>
        ) : (
          <>
            <div className="flex gap-4 border-b px-4 sm:px-6">
              {tabNames.map((name) => (
                <Button
                  key={name}
                  type="button"
                  variant="ghost"
                  aria-pressed={name === activeTab}
                  className={cn(
                    "-mb-px h-10 rounded-none border-b-2 px-1",
                    name === activeTab
                      ? "border-brand text-brand"
                      : "border-transparent text-muted-foreground",
                  )}
                  onClick={() => setSelectedTab(name)}
                >
                  {name}
                </Button>
              ))}
            </div>

            <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4 sm:p-6">
              {tab.sections.map((section, sectionIndex) => (
                <section key={section.id} className="space-y-3">
                  <h2 className="flex items-center gap-2 text-sm font-semibold">
                    <span className="size-2 rounded-full bg-brand" aria-hidden="true" />
                    {section.title || m.records_section_untitled()}
                  </h2>
                  <OutlineEditor
                    roots={section.roots}
                    onChange={(roots) => {
                      const next = structuredClone(contentRef.current);
                      const target = next.tabs[activeTab]?.sections[sectionIndex];
                      if (target) target.roots = roots;
                      setContent(next);
                      contentRef.current = next;
                    }}
                    onBlur={() => void persist(contentRef.current)}
                  />
                </section>
              ))}
            </div>
          </>
        )}
      </div>

      {sideOpen ? (
        <RecordSidePanel
          subjectType="report"
          subjectId={report.id}
          onClose={() => setSideOpen(false)}
        />
      ) : null}
    </div>
  );
}

function OutlineEditor({
  roots,
  onChange,
  onBlur,
}: {
  roots: OutlineNode[];
  onChange: (roots: OutlineNode[]) => void;
  onBlur: () => void;
}) {
  function updateNode(path: number[], text: string) {
    const next = structuredClone(roots);
    let cursor: OutlineNode[] = next;
    for (let i = 0; i < path.length - 1; i += 1) {
      cursor = cursor[path[i]!]!.children;
    }
    cursor[path[path.length - 1]!]!.text = text;
    onChange(next);
  }

  function addChild(path: number[]) {
    const next = structuredClone(roots);
    let cursor: OutlineNode = next[path[0]!]!;
    for (let i = 1; i < path.length; i += 1) cursor = cursor.children[path[i]!]!;
    cursor.children.push({ id: crypto.randomUUID(), text: "", children: [] });
    onChange(next);
  }

  function renderNodes(nodes: OutlineNode[], path: number[], depth: number) {
    return nodes.map((node, index) => {
      const currentPath = [...path, index];
      return (
        <div key={node.id} className="space-y-2" style={{ marginLeft: depth * 16 }}>
          <div className="flex gap-2">
            <input
              value={node.text}
              placeholder={m.records_outline_level({ level: Math.min(depth + 1, 4) })}
              onChange={(event) => updateNode(currentPath, event.target.value)}
              onBlur={onBlur}
              className="h-10 min-w-0 flex-1 rounded-lg bg-muted/60 px-3 text-sm outline-none ring-1 ring-border/60 ring-inset focus:ring-2 focus:ring-ring"
            />
            <Button
              type="button"
              variant="secondary"
              size="icon"
              aria-label={m.records_outline_add()}
              onClick={() => addChild(currentPath)}
            >
              +
            </Button>
          </div>
          {node.children.length > 0 ? renderNodes(node.children, currentPath, depth + 1) : null}
        </div>
      );
    });
  }

  return <div className="space-y-2">{renderNodes(roots, [], 0)}</div>;
}

function HighlightDetail({ highlight }: { highlight: HighlightSubject["highlight"] }) {
  const save = useServerFn(saveWeeklyHighlightContent);
  const [content, setContent] = useState(highlight.content);
  const contentRef = useRef(content);
  contentRef.current = content;
  const [sideOpen, setSideOpen] = useState(true);

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <PageHeader
          heading={highlight.title}
          leading={<BackToRecords />}
          meta={
            <span className="text-sm text-muted-foreground">
              {highlight.completedAt
                ? m.records_highlight_completed({
                    time: new Date(highlight.completedAt).toLocaleString(),
                  })
                : m.records_highlight_draft()}
            </span>
          }
          actions={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={m.records_side_chat()}
              aria-pressed={sideOpen}
              onClick={() => setSideOpen((open) => !open)}
            >
              <Message aria-hidden="true" />
            </Button>
          }
        />
        <div className="flex items-center gap-3 border-b px-4 py-4 sm:px-6">
          <span className="flex size-12 items-center justify-center rounded-full bg-brand/15 text-lg font-semibold text-brand">
            {highlight.cycle.week}
          </span>
          <div className="font-semibold">{highlight.title}</div>
        </div>
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4 sm:p-6">
          {content.blocks.map((block, index) => (
            <section key={block.id} className="space-y-2">
              <h2 className="text-sm font-semibold">{block.heading}</h2>
              <textarea
                value={block.paragraphs.join("\n")}
                onChange={(event) => {
                  const next = structuredClone(contentRef.current);
                  next.blocks[index]!.paragraphs = event.target.value.split("\n");
                  setContent(next);
                  contentRef.current = next;
                }}
                onBlur={() =>
                  void save({
                    data: { highlightId: highlight.id, content: contentRef.current },
                  })
                }
                rows={4}
                className="w-full rounded-lg bg-muted/50 px-3 py-2 text-sm outline-none ring-1 ring-border ring-inset focus:ring-2 focus:ring-ring"
              />
            </section>
          ))}
        </div>
      </div>
      {sideOpen ? (
        <RecordSidePanel
          subjectType="highlight"
          subjectId={highlight.id}
          onClose={() => setSideOpen(false)}
        />
      ) : null}
    </div>
  );
}
