import { useEffect, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
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
  const [sideOpen, setSideOpen] = useState(true);
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
    const savePromise = save({ data: { reportId, content: normalized, status } });
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
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <PageHeader
          heading={report.title}
          leading={<BackToRecords />}
          meta={
            <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
              <Avatar people={[{ name: report.author.displayName }]} size="sm" />
              <span className="truncate">{report.author.displayName}</span>
              {saving ? (
                <span className="shrink-0 text-xs">{m.records_report_saving()}</span>
              ) : null}
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
                    disabled={saving}
                    onClick={() => void persist(clearReportContent(), "draft")}
                  >
                    <Trash aria-hidden="true" />
                    {m.records_report_clear()}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          }
        />

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-8 sm:py-6">
          <h1 className="mb-6 text-3xl font-semibold tracking-tight md:text-4xl">{report.title}</h1>
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
