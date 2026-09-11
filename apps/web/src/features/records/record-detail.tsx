import { useEffect, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { DotsHorizontal, MessageChatCircle as Message, Trash01 as Trash } from "@untitledui/icons";

import { PageHeader } from "@/components/layout/page-header";
import { Avatar } from "@/components/base/avatar/avatar";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Dropdown } from "@/components/base/dropdown/dropdown";
import { TextArea } from "@/components/base/textarea/textarea";
import { avatarInitial, avatarToneClassName } from "@/lib/avatar-tone";
import { m } from "@/paraglide/messages";
import { ReportSectionEditor } from "./report-editor/report-section-editor";
import type { UploadResult } from "./report-editor/types";
import {
  readReportDraft,
  trackReportSave,
  waitForReportSave,
  writeReportDraft,
} from "./report-draft-cache";
import { saveWeeklyHighlightContent, saveWeeklyReportContent } from "./records.functions";
import {
  clearReportContent,
  normalizeReportContent,
  type HighlightContent,
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
    return <HighlightDetail key={subject.highlight.id} highlight={subject.highlight} />;
  }
  return <ReportDetail key={subject.report.id} report={subject.report} />;
}

async function fileToDataUrlUpload(file: File): Promise<UploadResult | null> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
  if (!dataUrl) return null;
  return {
    id: crypto.randomUUID(),
    link: dataUrl,
    markdownLink: dataUrl,
    fileName: file.name || "file",
    contentType: file.type || "application/octet-stream",
  };
}

function ReportDetail({ report }: { report: ReportSubject["report"] }) {
  const router = useRouter();
  const save = useServerFn(saveWeeklyReportContent);
  const [content, setContent] = useState(
    () => readReportDraft(report.id) ?? normalizeReportContent(report.content),
  );
  const contentRef = useRef(content);
  contentRef.current = content;
  const reportIdRef = useRef(report.id);
  reportIdRef.current = report.id;
  const [sideOpen, setSideOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  async function persist(
    next: ReportContent,
    status?: "draft" | "submitted" | "shared",
    reportId = reportIdRef.current,
  ) {
    setSaving(true);
    const normalized = normalizeReportContent(next);
    writeReportDraft(reportId, normalized);
    const savePromise = save({
      data: { reportId, content: normalized, status },
    });
    trackReportSave(reportId, savePromise);
    try {
      await savePromise;
      if (reportId === reportIdRef.current) {
        setContent(normalized);
        contentRef.current = normalized;
      }
    } finally {
      if (reportId === reportIdRef.current) setSaving(false);
    }
  }

  function schedulePersist(next: ReportContent) {
    setContent(next);
    contentRef.current = next;
    writeReportDraft(reportIdRef.current, next);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    const reportId = reportIdRef.current;
    // Match Multica Notes autosave delay (900ms).
    saveTimerRef.current = setTimeout(() => {
      void persist(contentRef.current, undefined, reportId);
    }, 900);
  }

  useEffect(() => {
    let cancelled = false;
    void waitForReportSave(report.id)?.then(() => {
      if (cancelled) return;
      const draft = readReportDraft(report.id);
      if (draft) {
        setContent(draft);
        contentRef.current = draft;
      }
      void router.invalidate();
    });
    return () => {
      cancelled = true;
    };
  }, [report.id, router]);

  useEffect(() => {
    return () => {
      if (!saveTimerRef.current) return;
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = undefined;
      const normalized = normalizeReportContent(contentRef.current);
      writeReportDraft(report.id, normalized);
      trackReportSave(
        report.id,
        save({
          data: {
            reportId: report.id,
            content: normalized,
          },
        }),
      );
    };
  }, [report.id, save]);

  return (
    <div className="flex min-h-0 flex-1">
      <div
        className={`${sideOpen ? "hidden md:flex" : "flex"} min-w-0 flex-1 flex-col overflow-hidden`}
      >
        <PageHeader
          heading={report.title}
          leading={<BackToRecords />}
          meta={
            <div className="flex min-w-0 items-center gap-2 text-sm text-tertiary">
              <Avatar
                size="sm"
                initials={avatarInitial(report.author.displayName)}
                contentClassName={avatarToneClassName(report.author.displayName)}
              />
              <span className="truncate">{report.author.displayName}</span>
              {saving ? (
                <span className="shrink-0 text-xs">{m.records_report_saving()}</span>
              ) : null}
            </div>
          }
          actions={
            <div className="flex items-center gap-1">
              <ButtonUtility
                size="sm"
                color="tertiary"
                icon={Message}
                aria-label={m.records_side_chat()}
                aria-pressed={sideOpen}
                onClick={() => setSideOpen((open) => !open)}
              />
              <Dropdown.Root>
                <ButtonUtility
                  size="sm"
                  color="tertiary"
                  icon={DotsHorizontal}
                  aria-label={m.records_report_actions()}
                  isDisabled={saving}
                />
                <Dropdown.Popover placement="bottom end" className="w-44">
                  <Dropdown.Menu onAction={() => void persist(clearReportContent(), "draft")}>
                    <Dropdown.Item id="clear" icon={Trash} label={m.records_report_clear()} />
                  </Dropdown.Menu>
                </Dropdown.Popover>
              </Dropdown.Root>
            </div>
          }
        />

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-8 sm:py-6">
          <ReportSectionEditor
            key={report.id}
            defaultValue={content.markdown}
            placeholder={m.records_report_body_placeholder()}
            className="min-h-[55vh] pb-[30vh]"
            onUploadFile={fileToDataUrlUpload}
            onUpdate={(markdown) => {
              schedulePersist({ markdown });
            }}
            onBlur={() => {
              if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
              void persist(contentRef.current);
            }}
          />
        </div>
      </div>

      {sideOpen ? (
        <RecordSidePanel
          key={report.id}
          subjectType="report"
          subjectId={report.id}
          onClose={() => setSideOpen(false)}
        />
      ) : null}
    </div>
  );
}

function HighlightDetail({ highlight }: { highlight: HighlightSubject["highlight"] }) {
  const save = useServerFn(saveWeeklyHighlightContent);
  const [content, setContent] = useState(highlight.content);
  const contentRef = useRef(content);
  contentRef.current = content;
  const [sideOpen, setSideOpen] = useState(false);

  return (
    <div className="flex min-h-0 flex-1">
      <div
        className={`${sideOpen ? "hidden md:flex" : "flex"} min-w-0 flex-1 flex-col overflow-hidden`}
      >
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
              size="sm"
              color="tertiary"
              icon={Message}
              aria-label={m.records_side_chat()}
              aria-pressed={sideOpen}
              onClick={() => setSideOpen((open) => !open)}
            />
          }
        />
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4 sm:p-6">
          {content.blocks.map((block, index) => (
            <section key={block.id} className="space-y-2">
              <h2 className="text-sm font-semibold text-primary">{block.heading}</h2>
              <TextArea
                value={block.paragraphs.join("\n")}
                onChange={(value) => {
                  const next = structuredClone(contentRef.current);
                  next.blocks[index]!.paragraphs = value.split("\n");
                  setContent(next);
                  contentRef.current = next;
                }}
                onBlur={() =>
                  void save({
                    data: {
                      highlightId: highlight.id,
                      content: contentRef.current,
                    },
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
