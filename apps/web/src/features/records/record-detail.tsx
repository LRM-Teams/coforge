import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  DotsHorizontal,
  Download01 as Download,
  Heart,
  MessageChatCircle as Message,
  Share01 as Share,
  Trash01 as Trash,
} from "@untitledui/icons";

import { PageHeader } from "@/components/layout/page-header";
import { Avatar } from "@/components/base/avatar/avatar";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Dropdown } from "@/components/base/dropdown/dropdown";
import { isAppError } from "@/lib/app-error";
import { m } from "@/paraglide/messages";
import { avatarInitial, avatarToneClassName } from "@/lib/avatar-tone";
import { useAppToast } from "@/components/ui/toast";
import { ReportSectionEditor } from "./report-editor/report-section-editor";
import { KEY_POINT_EXTRACTION_TAB, KeyPointExtractionPanel } from "./key-point-extraction-panel";
import { TeamKeyPointSection } from "./team-key-point-section";
import { ReportTabsEditor } from "./report-tabs-editor";
import type { UploadResult } from "./report-editor/types";
import {
  readReportDraft,
  clearReportDraft,
  resolveReportEditorContent,
  trackReportSave,
  waitForReportSave,
  writeReportDraft,
} from "./report-draft-cache";
import {
  deleteMemberWeeklyReport,
  deleteRecordNote,
  markWeeklyAssignmentOpened,
  restartPersonalKeyPointExtraction,
  startTeamKeyPointExtraction,
  saveRecordNote,
  saveWeeklyReportContent,
  sendWeeklyReportAssignments,
  setWeeklyReportFavorite,
} from "./records.functions";
import {
  clearReportContent,
  isAutoSendCancelled,
  normalizeReportContent,
  reportContentToMarkdown,
  withAssignmentUnread,
  withAutoSendCancelled,
  type ReportContent,
} from "./records-content";
import { copyText } from "./report-editor/lib/clipboard";
import {
  BackToRecords,
  RecordsKeyPointReturnBack,
  WeekBadge,
  useFormatEditHint,
} from "./records-layout";
import { RecordsReadingColumn } from "./records-reading-column";
import { RecordSidePanel } from "./record-side-panel";
import { readSidePanelPinned } from "./record-side-panel-pin";
import { TemplateChildrenTable, type TemplateChild } from "./template-children-table";
import { normalizeLeaderFormatTabs } from "./template-outline-sections";
import { WEEKLY_SEND_TOAST_MS, WeeklySendConfirmDialog } from "./weekly-send-confirm-dialog";
import { sendWindowEnd, useWeeklySendArmed } from "./use-send-window";

type ReportSubject = {
  type: "report";
  report: {
    id: string;
    kind: string;
    title: string;
    status: string;
    content: ReportContent;
    submittedAt?: string | null;
    sharedBy?: {
      userId: string;
      username: string;
      displayName: string;
      avatarUrl: string | null;
    } | null;
    author: { userId: string; username: string; displayName: string; avatarUrl: string | null };
    cycle: { id: string; year: number; week: number; title: string };
    sourceTemplateId?: string | null;
    unread?: boolean;
    canSendAssignments?: boolean;
    sendSchedule?: {
      sendWeekday: number;
      sendTime: string;
      scheduleEnabled: boolean;
      autoSendCancelled: boolean;
      alreadySent: boolean;
    } | null;
    editable?: boolean;
    favorited?: boolean;
    surface?: "format" | "overview";
    children?: TemplateChild[];
  };
};

type NoteSubject = {
  type: "note";
  note: {
    id: string;
    title: string;
    body: string;
    updatedAt: string;
    author: { userId: string; username: string; displayName: string };
  };
};

export function RecordDetail({
  subject,
  returnTo,
}: {
  subject: ReportSubject | NoteSubject;
  /** When set (from key-point @source links), show back to that Records path. */
  returnTo?: string;
}) {
  if (subject.type === "note") {
    return <NoteDetail key={subject.note.id} note={subject.note} />;
  }
  if (subject.report.kind === "template") {
    return (
      <TemplateReportDetail key={subject.report.id} report={subject.report} returnTo={returnTo} />
    );
  }
  return <ReportDetail key={subject.report.id} report={subject.report} returnTo={returnTo} />;
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

function ReportDetail({
  report,
  returnTo,
}: {
  report: ReportSubject["report"];
  returnTo?: string;
}) {
  const router = useRouter();
  const navigate = useNavigate();
  const toast = useAppToast();
  const save = useServerFn(saveWeeklyReportContent);
  const removeReport = useServerFn(deleteMemberWeeklyReport);
  const markOpened = useServerFn(markWeeklyAssignmentOpened);
  const setFavorite = useServerFn(setWeeklyReportFavorite);
  const restartKeyPoints = useServerFn(restartPersonalKeyPointExtraction);
  const editable = report.editable === true;
  const [content, setContent] = useState(() =>
    editable
      ? resolveReportEditorContent({
          serverContent: report.content,
          draft: readReportDraft(report.id),
        })
      : normalizeReportContent(report.content),
  );
  const contentRef = useRef(content);
  contentRef.current = content;
  const [editorRevision, setEditorRevision] = useState(0);
  const reportIdRef = useRef(report.id);
  reportIdRef.current = report.id;
  const isAssignment = Boolean(report.sourceTemplateId);
  const leaderReading = report.kind === "member" && report.editable !== true;
  const memberAssignee = report.kind === "member" && editable && isAssignment;
  const memberSurface = leaderReading
    ? ("member-leader" as const)
    : memberAssignee
      ? ("member-assignee" as const)
      : ("plain" as const);
  const [sideOpen, setSideOpen] = useState(() =>
    readSidePanelPinned("report", report.id, memberSurface),
  );

  useEffect(() => {
    setSideOpen(readSidePanelPinned("report", report.id, memberSurface));
  }, [report.id, memberSurface]);
  const [saving, setSaving] = useState(false);
  const [favorited, setFavorited] = useState(Boolean(report.favorited));
  const [favoriteBusy, setFavoriteBusy] = useState(false);
  const [keyPointRestartBusy, setKeyPointRestartBusy] = useState(false);
  const [status, setStatus] = useState(report.status);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const sent = status === "submitted" || status === "shared";

  useEffect(() => {
    setFavorited(Boolean(report.favorited));
  }, [report.favorited, report.id]);

  async function shareReport() {
    const url = typeof window !== "undefined" ? window.location.href : "";
    if (!url) return;
    const ok = await copyText(url);
    if (ok) toast.success(m.records_report_share_copied());
    else toast.error(m.records_report_share_failed());
  }

  function exportReport() {
    const markdown = reportContentToMarkdown(contentRef.current);
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${report.title}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function toggleFavorite() {
    if (favoriteBusy || report.kind !== "member") return;
    setFavoriteBusy(true);
    const next = !favorited;
    setFavorited(next);
    try {
      const result = await setFavorite({ data: { reportId: report.id, favorited: next } });
      setFavorited(result.favorited);
      await router.invalidate({ sync: true });
    } catch {
      setFavorited(!next);
    } finally {
      setFavoriteBusy(false);
    }
  }

  async function persist(
    next: ReportContent,
    nextStatus?: "draft" | "submitted" | "shared",
    reportId = reportIdRef.current,
  ) {
    if (!editable) return;
    setSaving(true);
    const normalized = normalizeReportContent(next);
    writeReportDraft(reportId, normalized);
    const savePromise = save({
      data: { reportId, content: normalized, status: nextStatus },
    });
    trackReportSave(reportId, savePromise);
    try {
      await savePromise;
      if (reportId === reportIdRef.current) {
        setContent(normalized);
        contentRef.current = normalized;
        if (nextStatus) setStatus(nextStatus);
      }
    } finally {
      if (reportId === reportIdRef.current) setSaving(false);
    }
  }

  function schedulePersist(next: ReportContent) {
    if (!editable) return;
    setContent(next);
    contentRef.current = next;
    writeReportDraft(reportIdRef.current, next);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    const reportId = reportIdRef.current;
    // Autosave delay: 900ms, debounced per keystroke.
    saveTimerRef.current = setTimeout(() => {
      void persist(contentRef.current, undefined, reportId);
    }, 900);
  }

  async function removeCurrentReport() {
    if (!editable || saving) return;
    setSaving(true);
    try {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = undefined;
      }
      await waitForReportSave(report.id);
      await removeReport({ data: { reportId: report.id } });
      clearReportDraft(report.id);
      await router.invalidate({ sync: true });
      void navigate({
        to: "/records",
        search: (previous) => ({
          tab: previous.tab === "notes" ? "notes" : "weekly",
        }),
      });
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    void waitForReportSave(report.id)?.then(() => {
      if (cancelled) return;
      if (editable) {
        const draft = readReportDraft(report.id);
        if (draft) {
          setContent(draft);
          contentRef.current = draft;
        }
      }
      void router.invalidate();
    });
    return () => {
      cancelled = true;
    };
  }, [editable, report.id, router]);

  useEffect(() => {
    if (!editable) {
      const server = normalizeReportContent(report.content);
      setContent(server);
      contentRef.current = server;
      return;
    }
    const next = resolveReportEditorContent({
      serverContent: report.content,
      draft: readReportDraft(report.id),
    });
    writeReportDraft(report.id, next);
    if (
      JSON.stringify(normalizeReportContent(contentRef.current)) ===
      JSON.stringify(normalizeReportContent(next))
    ) {
      return;
    }
    setContent(next);
    contentRef.current = next;
  }, [editable, report.content, report.id]);

  function applyAssistantBody(reportId: string, next: ReportContent) {
    if (reportId !== report.id) return;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = undefined;
    }
    const normalized = normalizeReportContent(next);
    writeReportDraft(report.id, normalized);
    setContent(normalized);
    contentRef.current = normalized;
    // TipTap keeps a dirty buffer; remount so the inserted body is visible immediately.
    setEditorRevision((value) => value + 1);
  }

  useEffect(() => {
    if (!editable || !isAssignment || !report.unread) return;
    let cancelled = false;
    void markOpened({ data: { reportId: report.id } }).then(() => {
      if (cancelled) return;
      const next = withAssignmentUnread(contentRef.current, false);
      setContent(next);
      contentRef.current = next;
      writeReportDraft(report.id, next);
      void router.invalidate();
    });
    return () => {
      cancelled = true;
    };
  }, [editable, isAssignment, markOpened, report.id, report.unread, router]);

  useEffect(() => {
    return () => {
      if (!editable || !saveTimerRef.current) return;
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
  }, [editable, report.id, save]);

  useEffect(() => {
    if (!leaderReading) return;
    const status = content.keyPointExtraction?.status;
    if (status !== "generating") return;
    const timer = setInterval(() => {
      void router.invalidate();
    }, 4000);
    return () => clearInterval(timer);
  }, [leaderReading, content.keyPointExtraction?.status, router]);

  async function restartPersonalKeyPoints() {
    if (!leaderReading || keyPointRestartBusy) return;
    setKeyPointRestartBusy(true);
    try {
      await restartKeyPoints({ data: { reportId: report.id } });
      await router.invalidate({ sync: true });
    } finally {
      setKeyPointRestartBusy(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div
        className={`${sideOpen ? "hidden md:flex" : "flex"} min-w-0 flex-1 flex-col overflow-hidden`}
      >
        <PageHeader
          heading={report.title}
          leading={
            <span className="flex items-center gap-2">
              {returnTo ? <RecordsKeyPointReturnBack returnTo={returnTo} /> : <BackToRecords />}
              <WeekBadge week={report.cycle.week} />
            </span>
          }
          meta={
            <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-sm text-tertiary">
              {report.kind === "member" ? (
                <>
                  <Avatar
                    size="sm"
                    alt={report.author.displayName}
                    src={report.author.avatarUrl ?? undefined}
                    initials={avatarInitial(report.author.displayName)}
                    contentClassName={avatarToneClassName(report.author.displayName)}
                  />
                  <span className="truncate text-primary">{report.author.displayName}</span>
                </>
              ) : null}
              {report.kind === "member" && report.submittedAt ? (
                <span className="truncate">
                  {m.records_report_shared_meta({
                    time: new Date(report.submittedAt).toLocaleString(),
                    name: report.sharedBy?.displayName ?? report.author.displayName,
                  })}
                </span>
              ) : null}
            </span>
          }
          actions={
            <div className="flex items-center gap-1">
              {editable && isAssignment ? (
                <Button
                  size="sm"
                  color="primary"
                  isDisabled={saving}
                  onPress={() => void persist(contentRef.current, "submitted")}
                >
                  {sent ? m.records_report_resend() : m.records_report_send()}
                </Button>
              ) : null}
              {report.kind === "member" ? (
                <ButtonUtility
                  size="sm"
                  color="tertiary"
                  icon={Heart}
                  aria-label={
                    favorited ? m.records_report_unfavorite() : m.records_report_favorite()
                  }
                  aria-pressed={favorited}
                  isDisabled={favoriteBusy}
                  className={favorited ? "text-brand-secondary" : undefined}
                  onClick={() => void toggleFavorite()}
                />
              ) : null}
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
                  isDisabled={saving || favoriteBusy}
                />
                <Dropdown.Popover placement="bottom end" className="w-44">
                  <Dropdown.Menu
                    onAction={(key) => {
                      if (key === "favorite") void toggleFavorite();
                      if (key === "share") void shareReport();
                      if (key === "export") exportReport();
                      if (key === "delete") void removeCurrentReport();
                    }}
                  >
                    <Dropdown.Item id="share" icon={Share} label={m.records_report_share()} />
                    <Dropdown.Item id="export" icon={Download} label={m.records_report_export()} />
                    {editable ? (
                      <Dropdown.Item id="delete" icon={Trash} label={m.records_report_delete()} />
                    ) : null}
                  </Dropdown.Menu>
                </Dropdown.Popover>
              </Dropdown.Root>
            </div>
          }
        />

        <ReportTabsEditor
          content={content}
          editable={editable}
          contentRevision={editorRevision}
          placeholder={m.records_report_body_placeholder()}
          onUploadFile={editable ? fileToDataUrlUpload : undefined}
          trailingTabs={
            leaderReading && sent
              ? [{ id: KEY_POINT_EXTRACTION_TAB, label: KEY_POINT_EXTRACTION_TAB }]
              : undefined
          }
          renderTrailingTab={(id) =>
            id === KEY_POINT_EXTRACTION_TAB ? (
              <KeyPointExtractionPanel
                extraction={content.keyPointExtraction}
                restartBusy={keyPointRestartBusy}
                onRestart={() => void restartPersonalKeyPoints()}
                editPrompt={{
                  slot: "personal",
                  returnTo: `/records/${report.id}`,
                }}
              />
            ) : null
          }
          onChange={schedulePersist}
          onBlur={() => {
            if (!editable) return;
            if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
            void persist(contentRef.current);
          }}
        />
      </div>

      <RecordSidePanel
        key={report.id}
        subjectType="report"
        subjectId={report.id}
        surface={memberSurface}
        open={sideOpen}
        onOpenChange={setSideOpen}
        onBodyApplied={applyAssistantBody}
        keyPointExtraction={leaderReading ? content.keyPointExtraction : undefined}
        keyPointRestartBusy={keyPointRestartBusy}
        onRestartKeyPointExtraction={
          leaderReading ? () => void restartPersonalKeyPoints() : undefined
        }
      />
    </div>
  );
}

function TemplateReportDetail({
  report,
  returnTo,
}: {
  report: ReportSubject["report"];
  returnTo?: string;
}) {
  const router = useRouter();
  const toast = useAppToast();
  const setFormatEditing = useFormatEditHint();
  const save = useServerFn(saveWeeklyReportContent);
  const sendAssignments = useServerFn(sendWeeklyReportAssignments);
  const startTeamKeyPoints = useServerFn(startTeamKeyPointExtraction);
  const isOverview = report.surface === "overview";
  const isOverviewLeader = isOverview && report.editable === true;
  const formatSurface = isOverview ? ("plain" as const) : ("format" as const);
  const [content, setContent] = useState(() =>
    normalizeLeaderFormatTabs(readReportDraft(report.id) ?? normalizeReportContent(report.content)),
  );
  const [teamKeyPointBusy, setTeamKeyPointBusy] = useState(false);
  const contentRef = useRef(content);
  contentRef.current = content;
  const reportIdRef = useRef(report.id);
  reportIdRef.current = report.id;
  const formatCancelled = isAutoSendCancelled(content, report.cycle.year, report.cycle.week);
  const [sideOpen, setSideOpen] = useState(() =>
    readSidePanelPinned("report", report.id, formatSurface),
  );

  useEffect(() => {
    setSideOpen(readSidePanelPinned("report", report.id, formatSurface));
  }, [report.id, formatSurface]);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [dirty, setDirty] = useState(() => {
    const draft = readReportDraft(report.id);
    if (!draft) return false;
    return (
      JSON.stringify(normalizeReportContent(draft)) !==
      JSON.stringify(normalizeReportContent(report.content))
    );
  });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [canSendAssignments, setCanSendAssignments] = useState(Boolean(report.canSendAssignments));
  const [sideRefresh, setSideRefresh] = useState(0);
  const sendSchedule = report.sendSchedule;
  const hasUnsavedEdits = dirty;

  const sendWindow = useMemo(
    () =>
      sendSchedule
        ? {
            alreadySent: sendSchedule.alreadySent,
            sendWeekday: sendSchedule.sendWeekday,
            sendTime: sendSchedule.sendTime,
            scheduleEnabled: sendSchedule.scheduleEnabled,
            autoSendCancelled: sendSchedule.autoSendCancelled || formatCancelled,
          }
        : null,
    [sendSchedule, formatCancelled],
  );
  const sendArmed = useWeeklySendArmed(sendWindow);
  const countdownUntil = useMemo(
    () => (sendWindow ? sendWindowEnd(sendWindow, sendArmed) : null),
    [sendWindow, sendArmed],
  );
  const formatCopy: "preview" | "cancelled" | "ready" = formatCancelled
    ? "cancelled"
    : sendArmed
      ? "preview"
      : "ready";

  useEffect(() => {
    setCanSendAssignments(Boolean(report.canSendAssignments));
    setDirty(false);
    setConfirmOpen(false);
  }, [report.canSendAssignments, report.id]);

  useEffect(() => {
    if (isOverview) {
      setFormatEditing(false);
      return;
    }
    setFormatEditing(hasUnsavedEdits);
    return () => setFormatEditing(false);
  }, [hasUnsavedEdits, isOverview, setFormatEditing]);

  async function persist(
    next: ReportContent,
    status?: "draft" | "submitted" | "shared",
    reportId = reportIdRef.current,
    options?: { askToSend?: boolean },
  ) {
    setSaving(true);
    const normalized = normalizeReportContent(next);
    writeReportDraft(reportId, normalized);
    const savePromise = save({
      data: {
        reportId,
        content: normalized,
        status,
        askToSend: options?.askToSend,
      },
    });
    trackReportSave(reportId, savePromise);
    try {
      const result = await savePromise;
      if (reportId === reportIdRef.current) {
        const nextContent = result.autoSendJustCancelled
          ? withAutoSendCancelled(normalized, report.cycle.year, report.cycle.week)
          : normalized;
        setContent(nextContent);
        contentRef.current = nextContent;
        writeReportDraft(reportId, nextContent);
        setDirty(false);
        if (result.assistantPosted) {
          setSideOpen(true);
          setSideRefresh((token) => token + 1);
        }
        if (result.autoSendJustCancelled) {
          await router.invalidate({ sync: true });
        }
      }
    } finally {
      if (reportId === reportIdRef.current) setSaving(false);
    }
  }

  function markLocalContent(next: ReportContent) {
    setContent(next);
    contentRef.current = next;
    setDirty(true);
    writeReportDraft(reportIdRef.current, next);
  }

  async function saveFormatEdits() {
    if (dirty) {
      await persist(contentRef.current, undefined, undefined, { askToSend: true });
    }
  }

  async function onSendAssignments() {
    if (sending || !canSendAssignments || hasUnsavedEdits) return;
    setSending(true);
    setSendError(null);
    try {
      await waitForReportSave(report.id);
      const draft = contentRef.current;
      try {
        await persist(draft);
      } catch {
        setSendError(m.records_report_send_assignments_error());
        setConfirmOpen(false);
        return;
      }
      try {
        await sendAssignments({
          data: {
            sourceReportId: report.id,
            content: normalizeReportContent(draft),
          },
        });
      } catch (error) {
        const cause =
          error && typeof error === "object" && "cause" in error
            ? (error as { cause: unknown }).cause
            : error;
        const appError = isAppError(cause) ? cause : isAppError(error) ? error : null;
        const errorId = appError?.errorId;
        setSendError(
          errorId === "weekly-send-no-settings"
            ? m.records_report_send_no_settings()
            : errorId === "weekly-send-no-recipients"
              ? m.records_report_send_no_recipients()
              : m.records_report_send_assignments_error(),
        );
        setConfirmOpen(false);
        return;
      }
      setCanSendAssignments(false);
      setConfirmOpen(false);
      toast.success(m.records_report_shared_toast(), { durationMs: WEEKLY_SEND_TOAST_MS });
      try {
        await router.invalidate({ sync: true });
      } catch {
        // Assignments already persisted; catalog refresh can retry on navigation.
      }
    } finally {
      setSending(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    void waitForReportSave(report.id)?.then(() => {
      if (cancelled) return;
      const draft = readReportDraft(report.id);
      if (draft) {
        const normalized = normalizeLeaderFormatTabs(draft);
        setContent(normalized);
        contentRef.current = normalized;
        setDirty(
          JSON.stringify(normalizeReportContent(normalized)) !==
            JSON.stringify(normalizeReportContent(report.content)),
        );
      }
      void router.invalidate();
    });
    return () => {
      cancelled = true;
    };
  }, [report.content, report.id, router]);

  useEffect(() => {
    if (!isOverview) return;
    const normalized = normalizeReportContent(report.content);
    setContent(normalized);
    contentRef.current = normalized;
  }, [isOverview, report.content, report.id]);

  useEffect(() => {
    if (!isOverviewLeader) return;
    if (content.keyPointExtraction?.status !== "generating") return;
    const timer = setInterval(() => {
      void router.invalidate();
    }, 4000);
    return () => clearInterval(timer);
  }, [isOverviewLeader, content.keyPointExtraction?.status, router]);

  async function onStartTeamKeyPoints() {
    if (!isOverviewLeader || teamKeyPointBusy) return;
    setTeamKeyPointBusy(true);
    try {
      await startTeamKeyPoints({
        data: { overviewReportId: report.id, force: true },
      });
      await router.invalidate({ sync: true });
    } finally {
      setTeamKeyPointBusy(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div
        className={`${sideOpen ? "hidden md:flex" : "flex"} min-w-0 flex-1 flex-col overflow-hidden`}
      >
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-secondary px-4 sm:px-6">
          <span className="flex shrink-0 items-center gap-2">
            {returnTo ? <RecordsKeyPointReturnBack returnTo={returnTo} /> : <BackToRecords />}
            <WeekBadge week={report.cycle.week} />
          </span>
          <h1 className="min-w-0 truncate text-base font-semibold text-primary sm:text-lg">
            {report.title}
          </h1>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {isOverview ? null : (
              <>
                {hasUnsavedEdits ? (
                  <Button
                    size="sm"
                    color="primary"
                    isDisabled={saving || sending}
                    onPress={() => void saveFormatEdits()}
                  >
                    {m.records_report_save()}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  color={hasUnsavedEdits ? "secondary" : "primary"}
                  isDisabled={saving || sending || !canSendAssignments || hasUnsavedEdits}
                  onPress={() => setConfirmOpen(true)}
                >
                  {m.records_report_send()}
                </Button>
              </>
            )}
            <ButtonUtility
              size="sm"
              color="tertiary"
              icon={Message}
              aria-label={m.records_side_chat()}
              aria-pressed={sideOpen}
              onClick={() => setSideOpen((open) => !open)}
            />
            {isOverview ? null : (
              <Dropdown.Root>
                <ButtonUtility
                  size="sm"
                  color="tertiary"
                  icon={DotsHorizontal}
                  aria-label={m.records_report_actions()}
                  isDisabled={saving || sending}
                />
                <Dropdown.Popover placement="bottom end" className="w-44">
                  <Dropdown.Menu
                    onAction={() => void persist(clearReportContent(contentRef.current), "draft")}
                  >
                    <Dropdown.Item id="clear" icon={Trash} label={m.records_report_clear()} />
                  </Dropdown.Menu>
                </Dropdown.Popover>
              </Dropdown.Root>
            )}
          </div>
        </header>
        {isOverview || !sendError ? null : (
          <p className="border-b border-secondary px-4 py-2 text-sm text-error-primary sm:px-8">
            {sendError}
          </p>
        )}

        {isOverview ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <RecordsReadingColumn>
              <TemplateChildrenTable children={report.children ?? []} />
              {isOverviewLeader ? (
                <TeamKeyPointSection
                  overviewReportId={report.id}
                  extraction={content.keyPointExtraction}
                  busy={teamKeyPointBusy}
                  onStart={() => void onStartTeamKeyPoints()}
                />
              ) : null}
            </RecordsReadingColumn>
          </div>
        ) : (
          <ReportTabsEditor
            content={content}
            editableTabs
            placeholder={m.records_report_body_placeholder()}
            onUploadFile={fileToDataUrlUpload}
            onChange={markLocalContent}
          />
        )}
      </div>

      <RecordSidePanel
        key={report.id}
        subjectType="report"
        subjectId={report.id}
        surface={formatSurface}
        formatCopy={formatCopy}
        countdownUntil={countdownUntil}
        refreshToken={sideRefresh}
        open={sideOpen}
        onOpenChange={setSideOpen}
        onRequestSend={() => {
          if (hasUnsavedEdits) return;
          setConfirmOpen(true);
        }}
      />

      <WeeklySendConfirmDialog
        open={confirmOpen}
        busy={sending}
        onOpenChange={setConfirmOpen}
        onConfirm={() => void onSendAssignments()}
      />
    </div>
  );
}

function NoteDetail({ note }: { note: NoteSubject["note"] }) {
  const router = useRouter();
  const save = useServerFn(saveRecordNote);
  const remove = useServerFn(deleteRecordNote);
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(() => readReportDraft(note.id)?.markdown ?? note.body);
  const titleRef = useRef(title);
  const bodyRef = useRef(body);
  titleRef.current = title;
  bodyRef.current = body;
  const noteIdRef = useRef(note.id);
  noteIdRef.current = note.id;
  const [saving, setSaving] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  async function persist(next: { title?: string; body?: string }, noteId = noteIdRef.current) {
    setSaving(true);
    try {
      writeReportDraft(noteId, { markdown: next.body ?? bodyRef.current });
      await trackReportSave(
        noteId,
        save({
          data: {
            noteId,
            title: next.title,
            body: next.body,
          },
        }),
      );
      void router.invalidate();
    } finally {
      setSaving(false);
    }
  }

  function schedulePersist(nextBody: string) {
    setBody(nextBody);
    bodyRef.current = nextBody;
    writeReportDraft(noteIdRef.current, { markdown: nextBody });
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = undefined;
      void persist({ body: bodyRef.current });
    }, 900);
  }

  async function commitTitle() {
    const next = titleRef.current.trim();
    setEditingTitle(false);
    if (!next) {
      setTitle(note.title);
      titleRef.current = note.title;
      return;
    }
    if (next === note.title) return;
    setTitle(next);
    await persist({ title: next });
  }

  async function clearBody() {
    setBody("");
    bodyRef.current = "";
    writeReportDraft(noteIdRef.current, { markdown: "" });
    await persist({ body: "" });
  }

  async function removeNote() {
    setSaving(true);
    try {
      await remove({ data: { noteId: note.id } });
      await router.invalidate({ sync: true });
      void router.navigate({ to: "/records", search: { tab: "notes" } });
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = undefined;
      writeReportDraft(note.id, { markdown: bodyRef.current });
      trackReportSave(
        note.id,
        save({
          data: {
            noteId: note.id,
            title: titleRef.current.trim() || note.title,
            body: bodyRef.current,
          },
        }),
      );
    };
  }, [note.id, note.title, save]);

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <PageHeader
          heading={title}
          leading={<BackToRecords />}
          actions={
            <Dropdown.Root>
              <ButtonUtility
                size="sm"
                color="tertiary"
                icon={DotsHorizontal}
                aria-label={m.records_note_actions()}
                isDisabled={saving}
              />
              <Dropdown.Popover placement="bottom end" className="w-44">
                <Dropdown.Menu
                  onAction={(key) => {
                    if (key === "clear") void clearBody();
                    if (key === "delete") void removeNote();
                  }}
                >
                  <Dropdown.Item id="clear" icon={Trash} label={m.records_report_clear()} />
                  <Dropdown.Item id="delete" icon={Trash} label={m.records_note_delete()} />
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown.Root>
          }
        />

        <div className="min-h-0 flex-1 overflow-y-auto">
          <RecordsReadingColumn>
            {editingTitle ? (
              <input
                autoFocus
                value={title}
                aria-label={m.records_note_title()}
                onChange={(event) => {
                  const next = event.target.value;
                  setTitle(next);
                  titleRef.current = next;
                }}
                onBlur={() => void commitTitle()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void commitTitle();
                  }
                  if (event.key === "Escape") {
                    setTitle(note.title);
                    titleRef.current = note.title;
                    setEditingTitle(false);
                  }
                }}
                className="mb-6 w-full bg-transparent text-3xl font-semibold tracking-tight text-primary outline-none md:text-4xl"
              />
            ) : (
              <Button
                type="button"
                size="sm"
                color="tertiary"
                onPress={() => setEditingTitle(true)}
                className="mb-6 h-auto w-full justify-start px-0 py-0 text-left text-3xl font-semibold tracking-tight text-primary md:text-4xl"
              >
                {title}
              </Button>
            )}
            <ReportSectionEditor
              key={note.id}
              defaultValue={body}
              placeholder={m.records_note_body_placeholder()}
              className="min-h-[55vh] pb-[45vh]"
              onUploadFile={fileToDataUrlUpload}
              onUpdate={(markdown) => {
                schedulePersist(markdown);
              }}
              onBlur={() => {
                if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
                void persist({ body: bodyRef.current });
              }}
            />
          </RecordsReadingColumn>
        </div>
      </div>
    </div>
  );
}
