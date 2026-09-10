import { useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { DotsHorizontal, MessageChatCircle as Message, Trash01 as Trash } from "@untitledui/icons";

import { PageHeader } from "@/components/layout/page-header";
import { Avatar } from "@/components/base/avatar/avatar";
import { avatarInitial, avatarToneClassName } from "@/lib/avatar-tone";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Dropdown } from "@/components/base/dropdown/dropdown";
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
            <div className="flex min-w-0 items-center gap-2 text-sm text-tertiary">
              <Avatar
                size="sm"
                alt={report.author.displayName}
                initials={avatarInitial(report.author.displayName)}
                contentClassName={avatarToneClassName(report.author.displayName)}
              />
              <span className="truncate">{report.author.displayName}</span>
            </div>
          }
          actions={
            <div className="flex items-center gap-1">
              <ButtonUtility
                icon={Message}
                size="sm"
                color="tertiary"
                aria-label={m.records_side_chat()}
                aria-pressed={sideOpen}
                onClick={() => setSideOpen((open) => !open)}
              />
              <Dropdown.Root>
                <ButtonUtility
                  icon={DotsHorizontal}
                  size="sm"
                  color="tertiary"
                  aria-label={m.records_report_actions()}
                />
                <Dropdown.Popover placement="bottom right">
                  <Dropdown.Menu
                    aria-label={m.records_report_actions()}
                    onAction={() => {
                      if (saving || tabNames.length === 0) return;
                      void persist(clearReportContent(contentRef.current), "draft");
                    }}
                  >
                    <Dropdown.Item
                      id="clear"
                      label={m.records_report_clear()}
                      icon={Trash}
                      isDisabled={saving || tabNames.length === 0}
                    />
                  </Dropdown.Menu>
                </Dropdown.Popover>
              </Dropdown.Root>
            </div>
          }
        />

        {tabNames.length === 0 ? (
          <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-tertiary">
            {m.records_tabs_from_dimensions_empty()}
          </div>
        ) : (
          <>
            <div className="flex gap-4 border-b border-secondary px-4 sm:px-6">
              {tabNames.map((name) => (
                <Button
                  key={name}
                  type="button"
                  color="tertiary"
                  aria-pressed={name === activeTab}
                  className={cn(
                    "-mb-px h-10 rounded-none border-b-2 px-1",
                    name === activeTab
                      ? "border-brand text-brand-secondary"
                      : "border-transparent text-tertiary",
                  )}
                  onPress={() => setSelectedTab(name)}
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
              className="h-10 min-w-0 flex-1 rounded-lg bg-secondary px-3 text-sm outline-none ring-1 ring-secondary ring-inset focus:ring-2 focus:ring-brand"
            />
            <Button
              type="button"
              color="secondary"
              size="sm"
              aria-label={m.records_outline_add()}
              onPress={() => addChild(currentPath)}
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
            <span className="text-sm text-tertiary">
              {highlight.completedAt
                ? m.records_highlight_completed({
                    time: new Date(highlight.completedAt).toLocaleString(),
                  })
                : m.records_highlight_draft()}
            </span>
          }
          actions={
            <ButtonUtility
              icon={Message}
              size="sm"
              color="tertiary"
              aria-label={m.records_side_chat()}
              aria-pressed={sideOpen}
              onClick={() => setSideOpen((open) => !open)}
            />
          }
        />
        <div className="flex items-center gap-3 border-b border-secondary px-4 py-4 sm:px-6">
          <span className="flex size-12 items-center justify-center rounded-full bg-brand-secondary text-lg font-semibold text-brand-secondary">
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
                className="w-full rounded-lg bg-secondary px-3 py-2 text-sm outline-none ring-1 ring-secondary ring-inset focus:ring-2 focus:ring-brand"
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
