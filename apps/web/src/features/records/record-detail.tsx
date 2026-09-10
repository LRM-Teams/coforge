import { useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  DotsHorizontal,
  MessageChatCircle as Message,
  Plus,
  Trash01 as Trash,
} from "@untitledui/icons";

import { Avatar } from "@/components/base/avatar/avatar";
import { Badge } from "@/components/base/badges/badges";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Dropdown } from "@/components/base/dropdown/dropdown";
import { Input } from "@/components/base/input/input";
import { TextArea } from "@/components/base/textarea/textarea";
import { Tabs } from "@/components/application/tabs/tabs";
import { avatarInitial, avatarToneClassName } from "@/lib/avatar-tone";
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

function reportStatusColor(status: string): "gray" | "success" | "blue" {
  if (status === "submitted") return "success";
  if (status === "shared") return "blue";
  return "gray";
}

function reportStatusLabel(status: string): string {
  if (status === "submitted") return m.records_status_submitted();
  if (status === "shared") return m.records_status_shared();
  return m.records_status_draft();
}

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

  function updateSectionRoots(tabName: string, sectionIndex: number, roots: OutlineNode[]) {
    const next = structuredClone(contentRef.current);
    const target = next.tabs[tabName]?.sections[sectionIndex];
    if (target) target.roots = roots;
    setContent(next);
    contentRef.current = next;
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 flex-wrap items-center gap-4 border-b border-secondary px-4 py-3 sm:px-6">
          <BackToRecords />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-lg font-semibold text-primary">{report.title}</h1>
              <Badge size="sm" color={reportStatusColor(report.status)}>
                {reportStatusLabel(report.status)}
              </Badge>
            </div>
            <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-sm text-tertiary">
              <Avatar
                size="xs"
                alt={report.author.displayName}
                initials={avatarInitial(report.author.displayName)}
                contentClassName={avatarToneClassName(report.author.displayName)}
              />
              <span className="truncate">{report.author.displayName}</span>
              <span aria-hidden="true">·</span>
              <span className="truncate">{report.cycle.title}</span>
            </p>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <ButtonUtility
              size="sm"
              color="tertiary"
              icon={Message}
              aria-pressed={sideOpen}
              aria-label={m.records_side_chat()}
              onClick={() => setSideOpen((open) => !open)}
            />
            <Dropdown.Root>
              <ButtonUtility
                size="sm"
                color="tertiary"
                icon={DotsHorizontal}
                aria-label={m.records_report_actions()}
              />
              <Dropdown.Popover placement="bottom end" className="w-44">
                <Dropdown.Menu
                  onAction={(key) => {
                    if (key === "clear")
                      void persist(clearReportContent(contentRef.current), "draft");
                  }}
                >
                  <Dropdown.Item
                    id="clear"
                    icon={Trash}
                    label={m.records_report_clear()}
                    isDisabled={saving || tabNames.length === 0}
                  />
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown.Root>
          </div>
        </div>

        {tabNames.length === 0 ? (
          <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-tertiary">
            {m.records_tabs_from_dimensions_empty()}
          </div>
        ) : (
          <Tabs
            selectedKey={activeTab}
            onSelectionChange={(key) => setSelectedTab(String(key))}
            className="flex min-h-0 flex-1 flex-col"
          >
            <Tabs.List type="underline" size="sm" className="px-4 sm:px-6">
              {tabNames.map((name) => (
                <Tabs.Item key={name} id={name} label={name} />
              ))}
            </Tabs.List>
            {tabNames.map((name) => (
              <Tabs.Panel
                key={name}
                id={name}
                className="min-h-0 flex-1 divide-y divide-secondary overflow-y-auto px-4 sm:px-6"
              >
                {(content.tabs[name] ?? emptyReportTab()).sections.map((section, sectionIndex) => (
                  <section key={section.id} className="space-y-3 py-6">
                    <h2 className="flex items-center gap-2 text-sm font-semibold text-primary">
                      <span className="size-1.5 rounded-full bg-brand-solid" aria-hidden="true" />
                      {section.title || m.records_section_untitled()}
                    </h2>
                    <OutlineEditor
                      roots={section.roots}
                      onChange={(roots) => updateSectionRoots(name, sectionIndex, roots)}
                      onBlur={() => void persist(contentRef.current)}
                    />
                  </section>
                ))}
              </Tabs.Panel>
            ))}
          </Tabs>
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
          <div className="flex items-center gap-2">
            <Input
              size="sm"
              className="flex-1"
              value={node.text}
              placeholder={m.records_outline_level({ level: Math.min(depth + 1, 4) })}
              onChange={(value) => updateNode(currentPath, value)}
              onBlur={onBlur}
            />
            <ButtonUtility
              size="sm"
              color="secondary"
              icon={Plus}
              aria-label={m.records_outline_add()}
              onClick={() => addChild(currentPath)}
            />
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
        <div className="flex shrink-0 flex-wrap items-center gap-4 border-b border-secondary px-4 py-3 sm:px-6">
          <BackToRecords />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-lg font-semibold text-primary">{highlight.title}</h1>
              <Badge size="sm" color={highlight.completedAt ? "success" : "gray"}>
                {highlight.completedAt
                  ? m.records_highlight_status_completed()
                  : m.records_highlight_status_draft()}
              </Badge>
            </div>
            {highlight.completedAt && (
              <p className="mt-0.5 text-sm text-tertiary">
                {m.records_highlight_completed({
                  time: new Date(highlight.completedAt).toLocaleString(),
                })}
              </p>
            )}
          </div>
          <div className="ml-auto shrink-0">
            <ButtonUtility
              size="sm"
              color="tertiary"
              icon={Message}
              aria-pressed={sideOpen}
              aria-label={m.records_side_chat()}
              onClick={() => setSideOpen((open) => !open)}
            />
          </div>
        </div>
        <div className="min-h-0 flex-1 divide-y divide-secondary overflow-y-auto px-4 sm:px-6">
          {content.blocks.map((block, index) => (
            <section key={block.id} className="space-y-2 py-6">
              <h2 className="text-sm font-semibold text-primary">{block.heading}</h2>
              <TextArea
                aria-label={block.heading}
                value={block.paragraphs.join("\n")}
                onChange={(value) => {
                  const next = structuredClone(contentRef.current);
                  next.blocks[index]!.paragraphs = value.split("\n");
                  setContent(next);
                  contentRef.current = next;
                }}
                onBlur={() =>
                  void save({
                    data: { highlightId: highlight.id, content: contentRef.current },
                  })
                }
                rows={4}
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
