import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { Link, getRouteApi, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  ChevronDown,
  ChevronRightDouble,
  DotsHorizontal,
  Edit01 as Edit,
  File02 as FileIcon,
  Microphone02 as Microphone,
  Paperclip,
  Pin01 as Pin,
  Plus,
  RefreshCcw01 as Refresh,
  Send01 as Send,
  Trash01 as Trash,
} from "@untitledui/icons";

import { Avatar } from "@/components/base/avatar/avatar";
import { Dropdown } from "@/components/base/dropdown/dropdown";
import { Dialog, Modal, ModalOverlay } from "@/components/application/modals/modal";
import { LoadingIndicator } from "@/components/ui/loading-indicator";
import { useSendWindowCountdown } from "./use-send-window";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Input } from "@/components/base/input/input";
import { TextArea } from "@/components/base/textarea/textarea";
import { avatarInitial, avatarToneClassName } from "@/lib/avatar-tone";
import { m } from "@/paraglide/messages";
import { formatAgentProfileParam } from "@/features/agents/profile-panel/profile-panel-search";
import { cx } from "@/utils/cx";
import { shouldSendOnEnter } from "../conversations/composer-behavior";
import { useConversationRealtime } from "../conversations/conversation-realtime-client";
import type { WeeklyReportAssistantSuggestion } from "../../server/records/weekly-report-assistant-suggestion.server";
import type { KeyPointExtractionMeta, ReportContent } from "./records-content";
import {
  addRecordComment,
  acceptMemberGenerateHelp,
  applyConfirmedKeyPointMarkdown,
  applyConfirmedWeeklyReportBody,
  dismissKeyPointConfirmDraft,
  archiveWeeklyReportAssistantChatSessionFn,
  confirmMemberReportIntent,
  createWeeklyReportAssistantChatSessionFn,
  declineMemberReportIntent,
  ensureRecordAssistantIntro,
  ensureWeeklyReportAssistantChatSessions,
  loadWeeklyReportAssistantContext,
  loadWeeklyReportAssistantMessages,
  loadWeeklyReportAssistantStatus,
  postWeeklyReportAssistantRequest,
  renameWeeklyReportAssistantChatSessionFn,
  startTeamKeyPointExtractionFromSideChat,
} from "./records.functions";
import {
  looksLikeMemberGenerateOfferAccept,
  looksLikeTeamKeyPointReorganizeRequest,
  looksLikeSideChatGreeting,
  shouldUseMemberReportRulePath,
  looksLikeSynthesizeWeeklyReportRequest,
  parseRecordAssistantPayload,
  type RecordAssistantPayload,
} from "./weekly-highlight-extract";
import {
  createWeeklyReportAssistantSessionStore,
  weeklyReportAssistantSubjectKey,
  type WeeklyReportAssistantMessage,
} from "./weekly-report-assistant-session";
import {
  readSidePanelPinned,
  writeSidePanelPinned,
  type RecordSideSurface,
} from "./record-side-panel-pin";
import { resolveAwaitingAssistantResume } from "./record-side-panel-awaiting";
import { WeeklyReportCollectPlanCard } from "./weekly-report-collect-plan-card";
import { WeeklyReportCollectRunCard } from "./weekly-report-collect-run-card";

type CommentRow = Awaited<ReturnType<typeof ensureRecordAssistantIntro>>[number];
type ChatSessionRow = Awaited<
  ReturnType<typeof ensureWeeklyReportAssistantChatSessions>
>["sessions"][number];

export type { RecordSideSurface };

function payloadOf(comment: CommentRow): RecordAssistantPayload | null {
  return parseRecordAssistantPayload(comment.payload);
}

const SIDE_PANEL_WIDTH_STORAGE_KEY = "coforge.records.side-panel-width";
const appRoute = getRouteApi("/_app");
const DEFAULT_SIDE_PANEL_WIDTH = 384;
const MIN_SIDE_PANEL_WIDTH = 280;

function readStoredSidePanelWidth(): number {
  if (typeof window === "undefined") return DEFAULT_SIDE_PANEL_WIDTH;
  const raw = window.localStorage.getItem(SIDE_PANEL_WIDTH_STORAGE_KEY);
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_SIDE_PANEL_WIDTH;
  return Math.max(MIN_SIDE_PANEL_WIDTH, parsed);
}

function writeStoredSidePanelWidth(width: number) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(SIDE_PANEL_WIDTH_STORAGE_KEY, String(Math.round(width)));
}

function assistantReady(
  status: Awaited<ReturnType<typeof loadWeeklyReportAssistantStatus>> | null,
) {
  return Boolean(status?.computerConfigured && status.runtimeConfigured);
}

function suggestionPreview(suggestion: WeeklyReportAssistantSuggestion): string {
  if (suggestion.type === "send-prompt") return "";
  if (suggestion.type === "key-point-edit") return suggestion.markdown.trim();
  if (suggestion.type !== "body-edit") return "";
  const tabs = suggestion.content.tabs ?? {};
  return Object.entries(tabs)
    .map(([name, tab]) => `## ${name}\n${tab.markdown.trimEnd()}`)
    .join("\n\n");
}

export function RecordSidePanel({
  subjectType,
  subjectId,
  surface,
  formatCopy,
  countdownUntil,
  refreshToken = 0,
  open,
  onOpenChange,
  onRequestSend,
  onBodyApplied,
  keyPointExtraction,
  keyPointRestartBusy,
  onRestartKeyPointExtraction,
}: {
  subjectType: "report" | "cycle";
  subjectId: string;
  surface: RecordSideSurface;
  formatCopy?: "preview" | "cancelled" | "ready";
  /** End of the open send window; the panel renders the countdown itself. */
  countdownUntil?: Date | null;
  refreshToken?: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRequestSend?: () => void;
  /** After Confirm body-edit, parent syncs the open editor (draft + view). */
  onBodyApplied?: (reportId: string, content: ReportContent) => void;
  /** Leader member-report: show personal key-point status + re-extract. */
  keyPointExtraction?: KeyPointExtractionMeta;
  keyPointRestartBusy?: boolean;
  onRestartKeyPointExtraction?: () => void;
}) {
  const router = useRouter();
  const { user: viewer } = appRoute.useLoaderData();
  const viewerName = viewer.name?.trim() || viewer.username?.trim() || m.records_side_chat_user();
  const countdown = useSendWindowCountdown(countdownUntil);
  const post = useServerFn(addRecordComment);
  const ensureIntro = useServerFn(ensureRecordAssistantIntro);
  const ensureSessions = useServerFn(ensureWeeklyReportAssistantChatSessions);
  const createSession = useServerFn(createWeeklyReportAssistantChatSessionFn);
  const renameSession = useServerFn(renameWeeklyReportAssistantChatSessionFn);
  const archiveSession = useServerFn(archiveWeeklyReportAssistantChatSessionFn);
  const acceptGenerateHelp = useServerFn(acceptMemberGenerateHelp);
  const confirmIntent = useServerFn(confirmMemberReportIntent);
  const declineIntent = useServerFn(declineMemberReportIntent);
  const loadAssistantContext = useServerFn(loadWeeklyReportAssistantContext);
  const loadAssistantStatus = useServerFn(loadWeeklyReportAssistantStatus);
  const loadAssistantMessages = useServerFn(loadWeeklyReportAssistantMessages);
  const postAssistantRequest = useServerFn(postWeeklyReportAssistantRequest);
  const startTeamFromSideChat = useServerFn(startTeamKeyPointExtractionFromSideChat);
  const applyBody = useServerFn(applyConfirmedWeeklyReportBody);
  const applyKeyPoints = useServerFn(applyConfirmedKeyPointMarkdown);
  const dismissKeyPointsDraft = useServerFn(dismissKeyPointConfirmDraft);
  const [sessionStore] = useState(createWeeklyReportAssistantSessionStore);
  const sessionKey = weeklyReportAssistantSubjectKey(subjectType, subjectId);
  const session = sessionStore.get(sessionKey);
  const [pinned, setPinned] = useState(() => readSidePanelPinned(subjectType, subjectId, surface));
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [chatSessions, setChatSessions] = useState<ChatSessionRow[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [legacySessionId, setLegacySessionId] = useState<string | null>(null);
  const [comments, setComments] = useState<CommentRow[]>([]);
  const [assistantMessages, setAssistantMessages] = useState<WeeklyReportAssistantMessage[]>(
    session.messages,
  );
  const [assistantStatus, setAssistantStatus] = useState<Awaited<
    ReturnType<typeof loadWeeklyReportAssistantStatus>
  > | null>(null);
  const [setupDismissed, setSetupDismissed] = useState(false);
  const [draft, setDraft] = useState("");
  const isComposingRef = useRef(false);
  const lastCompositionEndAtRef = useRef<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(session.error);
  const [dismissedSuggestionIds, setDismissedSuggestionIds] = useState<string[]>(
    session.dismissedSuggestionIds,
  );
  const [appliedSuggestionIds, setAppliedSuggestionIds] = useState<string[]>(
    session.appliedSuggestionIds,
  );
  const [awaitingSynthesis, setAwaitingSynthesis] = useState(false);
  const synthesisStartedAtRef = useRef<number | null>(null);
  const [assistantConversationId, setAssistantConversationId] = useState<string | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const legacySessionIdRef = useRef<string | null>(null);
  const loadThreadRef = useRef<(sessionId: string, legacyId: string | null) => Promise<void>>(
    async () => {},
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const programmaticScrollRef = useRef(false);
  const scrollReleaseTimerRef = useRef<number | null>(null);
  const asideRef = useRef<HTMLElement>(null);
  const panelDragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const panelWidthRef = useRef(DEFAULT_SIDE_PANEL_WIDTH);
  const [panelWidth, setPanelWidth] = useState(DEFAULT_SIDE_PANEL_WIDTH);
  panelWidthRef.current = panelWidth;
  const [displayWidth, setDisplayWidth] = useState(() => (open ? DEFAULT_SIDE_PANEL_WIDTH : 0));
  const wasOpenRef = useRef(open);

  useEffect(() => {
    setPinned(readSidePanelPinned(subjectType, subjectId, surface));
  }, [subjectType, subjectId, surface]);

  useLayoutEffect(() => {
    const stored = readStoredSidePanelWidth();
    const parent = asideRef.current?.parentElement;
    const max = parent ? Math.floor(parent.clientWidth / 2) : stored;
    const next = Math.min(Math.max(stored, MIN_SIDE_PANEL_WIDTH), max);
    setPanelWidth(next);
    if (open) setDisplayWidth(next);
  }, []);

  useLayoutEffect(() => {
    if (open) {
      const shouldAnimateIn = !wasOpenRef.current;
      wasOpenRef.current = true;
      if (shouldAnimateIn) {
        setDisplayWidth(0);
        const frame = requestAnimationFrame(() => setDisplayWidth(panelWidth));
        return () => cancelAnimationFrame(frame);
      }
      setDisplayWidth(panelWidth);
      return;
    }
    wasOpenRef.current = false;
    setDisplayWidth(0);
  }, [open, panelWidth]);

  useEffect(() => {
    function clampToParent() {
      const parent = asideRef.current?.parentElement;
      if (!parent) return;
      const max = Math.floor(parent.clientWidth / 2);
      setPanelWidth((current) => Math.min(Math.max(current, MIN_SIDE_PANEL_WIDTH), max));
    }
    window.addEventListener("resize", clampToParent);
    return () => window.removeEventListener("resize", clampToParent);
  }, []);

  function onPanelResizePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    panelDragRef.current = { startX: event.clientX, startWidth: panelWidthRef.current };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  function onPanelResizePointerMove(event: PointerEvent<HTMLDivElement>) {
    const drag = panelDragRef.current;
    if (!drag) return;
    const parent = asideRef.current?.parentElement;
    const max = parent ? Math.floor(parent.clientWidth / 2) : Math.floor(window.innerWidth / 2);
    // Dragging the left edge leftward widens the panel.
    const next = drag.startWidth + (drag.startX - event.clientX);
    setPanelWidth(Math.min(Math.max(next, MIN_SIDE_PANEL_WIDTH), max));
  }

  function onPanelResizePointerUp(event: PointerEvent<HTMLDivElement>) {
    if (!panelDragRef.current) return;
    panelDragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // already released
    }
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    writeStoredSidePanelWidth(panelWidthRef.current);
  }

  useEffect(() => {
    stickToBottomRef.current = true;
    setComments([]);
    setAssistantMessages(session.messages);
    setDraft(session.draft);
    setSetupDismissed(session.setupDismissed);
    setError(session.error);
    setDismissedSuggestionIds(session.dismissedSuggestionIds);
    setAppliedSuggestionIds(session.appliedSuggestionIds);
    setAwaitingSynthesis(false);
    synthesisStartedAtRef.current = null;
    setAssistantConversationId(null);
    setChatSessions([]);
    setActiveSessionId(null);
    setLegacySessionId(null);
  }, [sessionKey]);

  async function loadThread(sessionId: string, legacyId: string | null) {
    const [rows, status, context, chat] = await Promise.all([
      ensureIntro({
        data: { subjectType, subjectId, assistantSessionId: sessionId, surface, formatCopy },
      }),
      loadAssistantStatus().catch(() => null),
      loadAssistantContext({ data: { subjectType, subjectId } }).catch(() => null),
      loadAssistantMessages({
        data: {
          subjectType,
          subjectId,
          sessionId,
          includeLegacyUnscoped: legacyId === sessionId,
        },
      }).catch(() => null),
    ]);
    setComments(rows);
    setAssistantStatus(status);
    session.contextManifest = context;
    const messages = chat
      ? chat.messages.map((message) => ({
          id: message.id,
          body: message.displayBody,
          author: message.author,
          createdAt: message.createdAt,
          suggestion: message.suggestion,
        }))
      : [];
    if (chat) {
      setAssistantConversationId(chat.conversationId);
    }
    session.messages = messages;
    setAssistantMessages(messages);
    maybeResumeAwaitingAssistant(rows, messages);
    // After async load (incl. refresh), pin to latest turn once layout commits.
    stickToBottomRef.current = true;
  }

  function maybeResumeAwaitingAssistant(
    rows: CommentRow[],
    messages: WeeklyReportAssistantMessage[],
  ) {
    if (synthesisStartedAtRef.current != null) return;
    const pendingAt = resolveAwaitingAssistantResume(rows, messages);
    if (pendingAt == null) return;
    synthesisStartedAtRef.current = pendingAt;
    setAwaitingSynthesis(true);
  }

  activeSessionIdRef.current = activeSessionId;
  legacySessionIdRef.current = legacySessionId;
  loadThreadRef.current = loadThread;

  useConversationRealtime(assistantConversationId ?? "", async () => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) return;
    await loadThreadRef.current(sessionId, legacySessionIdRef.current);
  });

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      const ensured = await ensureSessions({ data: { subjectType, subjectId } });
      if (cancelled) return;
      setChatSessions(ensured.sessions);
      setLegacySessionId(ensured.legacySessionId);
      setActiveSessionId(ensured.activeSessionId);
      await loadThread(ensured.activeSessionId, ensured.legacySessionId);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    open,
    subjectType,
    subjectId,
    surface,
    formatCopy,
    ensureSessions,
    ensureIntro,
    loadAssistantContext,
    loadAssistantMessages,
    loadAssistantStatus,
    refreshToken,
    session,
  ]);

  useEffect(() => {
    if (!awaitingSynthesis || !activeSessionId) return;
    const timer = window.setInterval(() => {
      void loadThread(activeSessionId, legacySessionId);
    }, 4000);
    const timeout = window.setTimeout(() => {
      setAwaitingSynthesis(false);
      synthesisStartedAtRef.current = null;
    }, 180_000);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(timeout);
    };
  }, [awaitingSynthesis, activeSessionId, legacySessionId]);

  useEffect(() => {
    if (!awaitingSynthesis || synthesisStartedAtRef.current == null) return;
    const startedAt = synthesisStartedAtRef.current;
    const hasNewAssistant = assistantMessages.some(
      (message) => message.author === "assistant" && Date.parse(message.createdAt) > startedAt,
    );
    if (hasNewAssistant) {
      setAwaitingSynthesis(false);
      synthesisStartedAtRef.current = null;
      void router.invalidate();
    }
  }, [assistantMessages, awaitingSynthesis, router]);

  async function onNewChat() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createSession({ data: { subjectType, subjectId } });
      const ensured = await ensureSessions({ data: { subjectType, subjectId } });
      setChatSessions(ensured.sessions);
      setLegacySessionId(ensured.legacySessionId);
      setActiveSessionId(created.id);
      session.draft = "";
      setDraft("");
      await loadThread(created.id, ensured.legacySessionId);
    } catch {
      setError(m.records_weekly_ai_request_failed());
    } finally {
      setBusy(false);
    }
  }

  async function onSelectSession(sessionId: string) {
    if (busy || sessionId === activeSessionId) return;
    setBusy(true);
    setError(null);
    try {
      setActiveSessionId(sessionId);
      session.draft = "";
      setDraft("");
      await loadThread(sessionId, legacySessionId);
    } finally {
      setBusy(false);
    }
  }

  function togglePinned() {
    const next = !pinned;
    setPinned(next);
    writeSidePanelPinned(subjectType, subjectId, next);
  }

  function requestCollapse() {
    onOpenChange(false);
  }

  function openRename() {
    if (!activeSessionId) return;
    const current = chatSessions.find((row) => row.id === activeSessionId);
    const title = current?.title.trim() ?? "";
    setRenameDraft(title);
    setRenameOpen(true);
  }

  async function submitRename() {
    if (!activeSessionId || busy) return;
    const title = renameDraft.trim();
    if (!title) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await renameSession({ data: { sessionId: activeSessionId, title } });
      setChatSessions((rows) =>
        rows.map((row) => (row.id === updated.id ? { ...row, title: updated.title } : row)),
      );
      setRenameOpen(false);
    } catch {
      setError(m.records_weekly_ai_request_failed());
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteSession() {
    if (!activeSessionId || busy) return;
    if (!window.confirm(m.records_side_chat_delete_confirm())) return;
    setBusy(true);
    setError(null);
    try {
      await archiveSession({ data: { sessionId: activeSessionId } });
      const ensured = await ensureSessions({ data: { subjectType, subjectId } });
      setChatSessions(ensured.sessions);
      setLegacySessionId(ensured.legacySessionId);
      setActiveSessionId(ensured.activeSessionId);
      session.draft = "";
      setDraft("");
      await loadThread(ensured.activeSessionId, ensured.legacySessionId);
    } catch {
      setError(m.records_weekly_ai_request_failed());
    } finally {
      setBusy(false);
    }
  }

  function dismissSuggestion(messageId: string) {
    const next = sessionStore.markSuggestionDismissed(sessionKey, messageId);
    setDismissedSuggestionIds(next);
  }

  async function onIgnoreSuggestion(
    messageId: string,
    suggestion: WeeklyReportAssistantSuggestion,
  ) {
    if (busy || appliedSuggestionIds.includes(messageId)) return;
    if (dismissedSuggestionIds.includes(messageId)) return;
    dismissSuggestion(messageId);
    if (suggestion.type !== "key-point-edit") return;
    setBusy(true);
    setError(null);
    try {
      await dismissKeyPointsDraft({ data: { reportId: suggestion.reportId } });
      await router.invalidate({ sync: true });
    } catch {
      // Card is already frozen locally; keep page refresh best-effort.
    } finally {
      setBusy(false);
    }
  }

  function markSuggestionApplied(messageId: string) {
    const next = sessionStore.markSuggestionApplied(sessionKey, messageId);
    setAppliedSuggestionIds(next);
  }

  async function confirmSuggestion(messageId: string, suggestion: WeeklyReportAssistantSuggestion) {
    if (busy) return;
    if (appliedSuggestionIds.includes(messageId)) return;
    if (suggestion.type === "send-prompt") {
      markSuggestionApplied(messageId);
      onRequestSend?.();
      return;
    }
    if (suggestion.type === "key-point-edit") {
      setBusy(true);
      setError(null);
      session.error = null;
      try {
        await applyKeyPoints({
          data: {
            reportId: suggestion.reportId,
            markdown: suggestion.markdown,
          },
        });
        markSuggestionApplied(messageId);
        await router.invalidate({ sync: true });
      } catch {
        const message = m.records_assistant_write_failed();
        session.error = message;
        setError(message);
      } finally {
        setBusy(false);
      }
      return;
    }
    if (suggestion.type !== "body-edit") {
      dismissSuggestion(messageId);
      return;
    }
    setBusy(true);
    setError(null);
    session.error = null;
    try {
      await applyBody({
        data: {
          reportId: suggestion.reportId,
          content: suggestion.content as ReportContent,
        },
      });
      onBodyApplied?.(suggestion.reportId, suggestion.content as ReportContent);
      markSuggestionApplied(messageId);
      await router.invalidate({ sync: true });
    } catch {
      const message = m.records_assistant_write_failed();
      session.error = message;
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const send = shouldSendOnEnter(
      {
        key: event.key,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        isComposing: event.nativeEvent.isComposing || isComposingRef.current,
        keyCode: event.keyCode,
      },
      { lastCompositionEndAt: lastCompositionEndAtRef.current, now: Date.now() },
      { newlineModifier: "ctrl" },
    );
    if (!send) return;
    event.preventDefault();
    void onSubmit(event as unknown as FormEvent);
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || busy || awaitingSynthesis || !activeSessionId) return;
    stickToBottomRef.current = true;
    setBusy(true);
    setError(null);
    session.error = null;
    try {
      if (
        surface === "plain" &&
        subjectType === "report" &&
        looksLikeTeamKeyPointReorganizeRequest(body)
      ) {
        await startTeamFromSideChat({
          data: {
            overviewReportId: subjectId,
            sessionId: activeSessionId,
            body,
            requestId: crypto.randomUUID(),
          },
        });
        session.draft = "";
        setDraft("");
        synthesisStartedAtRef.current = Date.now();
        setAwaitingSynthesis(true);
        await loadThread(activeSessionId, legacySessionId);
        await router.invalidate({ sync: true });
        return;
      }

      const useRulePath =
        looksLikeSideChatGreeting(body) ||
        shouldUseMemberReportRulePath(surface, body) ||
        !assistantReady(assistantStatus);
      if (useRulePath) {
        if (!assistantReady(assistantStatus)) {
          session.setupDismissed = false;
          setSetupDismissed(false);
        }
        const rows = await post({
          data: { subjectType, subjectId, body, assistantSessionId: activeSessionId },
        });
        session.draft = "";
        setDraft("");
        setComments(rows);
        if (looksLikeSynthesizeWeeklyReportRequest(body)) {
          void loadThread(activeSessionId, legacySessionId);
        }
        const ensured = await ensureSessions({ data: { subjectType, subjectId } });
        setChatSessions(ensured.sessions);
        return;
      }

      const result = await postAssistantRequest({
        data: {
          subjectType,
          subjectId,
          sessionId: activeSessionId,
          body,
          requestId: crypto.randomUUID(),
        },
      });
      if (result.kind === "needs_setup") {
        setAssistantStatus(result.status);
        session.setupDismissed = false;
        setSetupDismissed(false);
        return;
      }
      if (result.kind === "rule") {
        session.draft = "";
        setDraft("");
        setComments(result.comments);
        const ensured = await ensureSessions({ data: { subjectType, subjectId } });
        setChatSessions(ensured.sessions);
        return;
      }

      session.draft = "";
      setDraft("");
      synthesisStartedAtRef.current = Date.now();
      setAwaitingSynthesis(true);
      const chat = await loadAssistantMessages({
        data: {
          subjectType,
          subjectId,
          sessionId: activeSessionId,
          includeLegacyUnscoped: legacySessionId === activeSessionId,
        },
      });
      setAssistantConversationId(chat.conversationId);
      const refreshed = chat.messages.map((message) => ({
        id: message.id,
        body: message.displayBody,
        author: message.author,
        createdAt: message.createdAt,
        suggestion: message.suggestion,
      }));
      session.messages = refreshed;
      setAssistantMessages(refreshed);
      const ensured = await ensureSessions({ data: { subjectType, subjectId } });
      setChatSessions(ensured.sessions);
    } catch {
      const message = m.records_weekly_ai_request_failed();
      session.error = message;
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  async function onAcceptGenerateHelp() {
    if (subjectType !== "report" || busy || !activeSessionId) return;
    setBusy(true);
    setError(null);
    try {
      const rows = await acceptGenerateHelp({
        data: { reportId: subjectId, assistantSessionId: activeSessionId },
      });
      setComments(rows);
    } finally {
      setBusy(false);
    }
  }

  async function onConfirmIntent(intent: "collect-again" | "synthesize", userGuidance?: string) {
    if (subjectType !== "report" || busy || !activeSessionId) return;
    setBusy(true);
    setError(null);
    try {
      const rows = await confirmIntent({
        data: {
          reportId: subjectId,
          assistantSessionId: activeSessionId,
          intent,
          ...(userGuidance ? { userGuidance } : {}),
        },
      });
      setComments(rows);
      if (intent === "synthesize") {
        stickToBottomRef.current = true;
        synthesisStartedAtRef.current = Date.now();
        setAwaitingSynthesis(true);
        await loadThread(activeSessionId, legacySessionId);
      }
    } finally {
      setBusy(false);
    }
  }

  async function onDeclineIntent() {
    if (subjectType !== "report" || busy || !activeSessionId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await declineIntent({
        data: { reportId: subjectId, assistantSessionId: activeSessionId },
      });
      setComments(result.comments);
      if (result.forwarded) {
        stickToBottomRef.current = true;
        synthesisStartedAtRef.current = Date.now();
        setAwaitingSynthesis(true);
        await loadThread(activeSessionId, legacySessionId);
      }
    } finally {
      setBusy(false);
    }
  }

  const totalCount = comments.length + assistantMessages.length;
  const activeSession = chatSessions.find((row) => row.id === activeSessionId);
  const sessionTitle = activeSession?.title.trim() || m.records_side_chat_untitled();

  const firstCollectRunCommentIdByRun = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of comments) {
      const payload = payloadOf(row);
      if (payload?.kind !== "collect-run") continue;
      if (!map.has(payload.runId)) map.set(payload.runId, row.id);
    }
    return map;
  }, [comments]);

  const timeline = useMemo(() => {
    type Item =
      | { source: "comment"; at: number; id: string; comment: CommentRow }
      | { source: "dm"; at: number; id: string; message: WeeklyReportAssistantMessage };
    const items: Item[] = [
      ...comments.map((comment) => ({
        source: "comment" as const,
        at: Date.parse(comment.createdAt),
        id: `comment:${comment.id}`,
        comment,
      })),
      ...assistantMessages.map((message) => ({
        source: "dm" as const,
        at: Date.parse(message.createdAt),
        id: `dm:${message.id}`,
        message,
      })),
    ];
    items.sort((left, right) => {
      if (left.at !== right.at) return left.at - right.at;
      return left.source === right.source ? 0 : left.source === "comment" ? -1 : 1;
    });
    return items;
  }, [assistantMessages, comments]);

  const timelineTailId = timeline.at(-1)?.id ?? "";
  const sendLocked = busy || awaitingSynthesis;

  function scrollThreadToBottom(behavior: ScrollBehavior = "auto") {
    const scroller = scrollRef.current;
    if (!scroller) return;
    programmaticScrollRef.current = true;
    if (scrollReleaseTimerRef.current != null) {
      window.clearTimeout(scrollReleaseTimerRef.current);
      scrollReleaseTimerRef.current = null;
    }
    scroller.scrollTo({ top: scroller.scrollHeight, behavior });
    scroller.scrollTop = scroller.scrollHeight;
    // Ignore scroll events from our own move so stick-to-bottom is not cleared mid-flight.
    const releaseMs = behavior === "smooth" ? 450 : 0;
    scrollReleaseTimerRef.current = window.setTimeout(() => {
      programmaticScrollRef.current = false;
      scrollReleaseTimerRef.current = null;
    }, releaseMs);
  }

  function onThreadScroll() {
    if (programmaticScrollRef.current) return;
    const scroller = scrollRef.current;
    if (!scroller) return;
    stickToBottomRef.current =
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 72;
  }

  useLayoutEffect(() => {
    stickToBottomRef.current = true;
    scrollThreadToBottom("auto");
  }, [sessionKey, activeSessionId]);

  useLayoutEffect(() => {
    if (!stickToBottomRef.current) return;
    // Jump, don't animate: smooth mid-scroll used to clear stick-to-bottom via onScroll.
    scrollThreadToBottom("auto");
  }, [timelineTailId, timeline.length, awaitingSynthesis]);

  // Collect cards / images can grow after the first paint; keep pinned while sticking.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!stickToBottomRef.current) return;
      scrollThreadToBottom("auto");
    });
    observer.observe(scroller);
    for (const child of scroller.children) {
      observer.observe(child);
    }
    return () => observer.disconnect();
  }, [timelineTailId, timeline.length]);

  useEffect(() => {
    return () => {
      if (scrollReleaseTimerRef.current != null) {
        window.clearTimeout(scrollReleaseTimerRef.current);
      }
    };
  }, []);

  return (
    <aside
      ref={asideRef}
      style={{
        width: displayWidth,
        transition: "width 220ms cubic-bezier(0.32, 0.72, 0, 1)",
      }}
      aria-hidden={!open}
      className={cx(
        "relative flex shrink-0 flex-col overflow-hidden bg-primary",
        open || displayWidth > 0 ? "border-l border-secondary" : "border-l-0",
      )}
    >
      <div
        className="flex h-full min-h-0 flex-col"
        style={{ width: panelWidth, minWidth: panelWidth }}
      >
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={m.controls_resize_sidebar()}
          aria-valuenow={Math.round(panelWidth)}
          tabIndex={open ? 0 : -1}
          onPointerDown={onPanelResizePointerDown}
          onPointerMove={onPanelResizePointerMove}
          onPointerUp={onPanelResizePointerUp}
          onPointerCancel={onPanelResizePointerUp}
          onKeyDown={(event) => {
            const parent = asideRef.current?.parentElement;
            const max = parent
              ? Math.floor(parent.clientWidth / 2)
              : Math.floor(window.innerWidth / 2);
            const step = event.shiftKey ? 48 : 16;
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              setPanelWidth((current) => {
                const next = Math.min(current + step, max);
                writeStoredSidePanelWidth(next);
                return next;
              });
            } else if (event.key === "ArrowRight") {
              event.preventDefault();
              setPanelWidth((current) => {
                const next = Math.max(current - step, MIN_SIDE_PANEL_WIDTH);
                writeStoredSidePanelWidth(next);
                return next;
              });
            }
          }}
          className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none hover:bg-brand-solid/20 active:bg-brand-solid/30"
        />
        <div className="flex items-center gap-1 border-b border-secondary px-3 py-2.5">
          <ButtonUtility
            size="sm"
            color="tertiary"
            icon={Plus}
            aria-label={m.records_side_chat_new()}
            tooltip={m.records_side_chat_new()}
            isDisabled={busy}
            onClick={() => void onNewChat()}
          />
          <Dropdown.Root>
            <Button
              size="sm"
              color="tertiary"
              className="min-w-0 flex-1 justify-start"
              iconTrailing={ChevronDown}
              isDisabled={busy || chatSessions.length === 0}
              aria-label={m.records_side_chat_history()}
            >
              <span className="truncate">{sessionTitle}</span>
            </Button>
            <Dropdown.Popover placement="bottom start" className="w-64">
              <Dropdown.Menu
                aria-label={m.records_side_chat_history()}
                selectedKeys={activeSessionId ? [activeSessionId] : []}
                selectionMode="single"
                onAction={(key) => {
                  if (typeof key === "string") void onSelectSession(key);
                }}
              >
                {chatSessions.length === 0 ? (
                  <Dropdown.Item id="empty" isDisabled label={m.records_side_chat_no_history()} />
                ) : (
                  chatSessions.map((row) => (
                    <Dropdown.Item
                      key={row.id}
                      id={row.id}
                      label={row.title.trim() || m.records_side_chat_untitled()}
                      addon={new Date(row.updatedAt).toLocaleString()}
                    />
                  ))
                )}
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown.Root>
          <span className="shrink-0 text-xs text-tertiary">
            {m.records_side_chat_count({ count: totalCount })}
          </span>
          <Dropdown.Root>
            <ButtonUtility
              size="sm"
              color="tertiary"
              icon={DotsHorizontal}
              aria-label={m.records_side_chat_menu()}
              tooltip={m.records_side_chat_menu()}
              isDisabled={busy || !activeSessionId}
            />
            <Dropdown.Popover placement="bottom end" className="w-40">
              <Dropdown.Menu
                aria-label={m.records_side_chat_menu()}
                onAction={(key) => {
                  if (key === "rename") openRename();
                  if (key === "delete") void onDeleteSession();
                }}
              >
                <Dropdown.Item id="rename" icon={Edit} label={m.records_side_chat_rename()} />
                <Dropdown.Item id="delete" icon={Trash} label={m.records_side_chat_delete()} />
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown.Root>
          <ButtonUtility
            size="sm"
            color="tertiary"
            icon={Pin}
            aria-label={pinned ? m.records_side_chat_unpin() : m.records_side_chat_pin()}
            tooltip={pinned ? m.records_side_chat_unpin() : m.records_side_chat_pin()}
            aria-pressed={pinned}
            className={pinned ? "text-brand-secondary" : undefined}
            onClick={togglePinned}
          />
          <ButtonUtility
            size="sm"
            color="tertiary"
            icon={ChevronRightDouble}
            aria-label={m.controls_hide_sidebar()}
            tooltip={m.controls_hide_sidebar()}
            onClick={requestCollapse}
          />
        </div>

        <div
          ref={scrollRef}
          onScroll={onThreadScroll}
          className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 pb-2"
        >
          {assistantStatus &&
          (!assistantStatus.computerConfigured || !assistantStatus.runtimeConfigured) &&
          !setupDismissed ? (
            <div className="space-y-3 rounded-xl border border-secondary bg-warning-primary p-3">
              <div>
                <p className="text-sm font-semibold text-primary">
                  {m.records_weekly_ai_setup_title()}
                </p>
                <p className="mt-1 text-sm text-secondary">
                  {m.records_weekly_ai_setup_description()}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  to="/agents"
                  search={{
                    profile: formatAgentProfileParam(assistantStatus.agentId),
                    agentTab: "profile",
                  }}
                  className="text-sm font-semibold text-brand-secondary"
                >
                  {m.records_weekly_ai_setup_action()}
                </Link>
                <Button
                  size="sm"
                  color="tertiary"
                  onPress={() => {
                    session.setupDismissed = true;
                    setSetupDismissed(true);
                  }}
                >
                  {m.records_weekly_ai_setup_dismiss()}
                </Button>
              </div>
            </div>
          ) : null}
          {keyPointExtraction &&
          (keyPointExtraction.status === "ready" ||
            keyPointExtraction.status === "failed" ||
            keyPointExtraction.status === "pending_setup") ? (
            <div className="space-y-3 rounded-xl border border-secondary bg-secondary_subtle p-3">
              <div>
                <p className="text-sm font-semibold text-primary">
                  {keyPointExtraction.status === "ready"
                    ? m.records_key_points_side_ready_title()
                    : m.records_key_points_restart()}
                </p>
                <p className="mt-1 text-sm text-secondary">
                  {keyPointExtraction.status === "ready"
                    ? m.records_key_points_side_ready()
                    : keyPointExtraction.status === "pending_setup"
                      ? m.records_key_points_side_pending()
                      : m.records_key_points_side_failed()}
                </p>
              </div>
              {onRestartKeyPointExtraction ? (
                <Button
                  size="sm"
                  color="secondary"
                  iconLeading={Refresh}
                  isDisabled={keyPointRestartBusy}
                  onPress={() => onRestartKeyPointExtraction()}
                >
                  {m.records_key_points_restart()}
                </Button>
              ) : null}
            </div>
          ) : null}
          {keyPointExtraction?.status === "generating" ? (
            <p className="text-sm text-tertiary">{m.records_key_points_generating()}</p>
          ) : null}
          {error ? <p className="text-sm text-error-primary">{error}</p> : null}
          {comments.length === 0 && assistantMessages.length === 0 ? (
            <p className="text-sm text-tertiary">{m.records_side_chat_empty()}</p>
          ) : null}
          {timeline.map((item) => {
            if (item.source === "comment") {
              const comment = item.comment;
              const authorName =
                comment.authorType === "assistant"
                  ? m.records_side_chat_assistant()
                  : comment.authorType === "system"
                    ? m.records_side_chat_system()
                    : comment.author?.displayName?.trim() ||
                      comment.author?.username?.trim() ||
                      viewerName;
              const payload = payloadOf(comment);
              const generateHelpConsumed = comments.some(
                (row) => row.authorType === "user" && looksLikeMemberGenerateOfferAccept(row.body),
              );
              const commentIndex = comments.findIndex((row) => row.id === comment.id);
              const intentResolved =
                commentIndex >= 0 &&
                comments.slice(commentIndex + 1).some((row) => {
                  const later = payloadOf(row);
                  return (
                    later?.kind === "collect-plan" ||
                    later?.kind === "intent-declined" ||
                    (row.authorType === "user" && (row.body === "确认" || row.body === "不是"))
                  );
                });
              return (
                <article key={item.id} className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Avatar
                      size="xs"
                      alt={authorName}
                      src={comment.author?.avatarUrl ?? undefined}
                      initials={avatarInitial(authorName)}
                      contentClassName={avatarToneClassName(authorName)}
                    />
                    <span className="text-sm font-medium text-primary">{authorName}</span>
                    <span className="ml-auto text-xs text-tertiary">
                      {new Date(comment.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <p className="whitespace-pre-wrap text-sm leading-6 text-primary">
                    {comment.body}
                  </p>
                  {payload?.kind === "offer-send" ? (
                    <AssistantAttachmentCard payload={payload} countdown={countdown} />
                  ) : null}
                  {payload?.kind === "offer-help-generate" && !generateHelpConsumed ? (
                    <Button
                      size="sm"
                      color="primary"
                      isDisabled={busy}
                      onPress={() => void onAcceptGenerateHelp()}
                    >
                      {m.records_assistant_need_help()}
                    </Button>
                  ) : null}
                  {payload?.kind === "confirm-intent" && !intentResolved ? (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        color="primary"
                        isDisabled={busy}
                        onPress={() => void onConfirmIntent(payload.intent, payload.userGuidance)}
                      >
                        {m.records_assistant_confirm_yes()}
                      </Button>
                      <Button
                        size="sm"
                        color="secondary"
                        isDisabled={busy}
                        onPress={() => void onDeclineIntent()}
                      >
                        {m.records_assistant_confirm_no()}
                      </Button>
                    </div>
                  ) : null}
                  {payload?.kind === "collect-plan" ? (
                    <WeeklyReportCollectPlanCard
                      reportId={payload.reportId}
                      year={payload.year}
                      week={payload.week}
                      disabled={comments
                        .slice(comments.findIndex((row) => row.id === comment.id) + 1)
                        .some((row) => payloadOf(row)?.kind === "collect-run")}
                      onSubmitted={() => {
                        if (!activeSessionId) return;
                        void ensureIntro({
                          data: {
                            subjectType,
                            subjectId,
                            assistantSessionId: activeSessionId,
                            surface,
                          },
                        }).then((rows) => setComments(rows));
                      }}
                    />
                  ) : null}
                  {payload?.kind === "collect-run" &&
                  firstCollectRunCommentIdByRun.get(payload.runId) === comment.id ? (
                    <WeeklyReportCollectRunCard
                      runId={payload.runId}
                      onCollectAdvanced={() => {
                        if (!activeSessionId) return;
                        void loadThread(activeSessionId, legacySessionId);
                      }}
                    />
                  ) : null}
                  {payload?.kind === "offer-send" ? (
                    <Button
                      size="sm"
                      color="primary"
                      isDisabled={busy}
                      onPress={() => onRequestSend?.()}
                    >
                      {m.records_assistant_confirm_send()}
                    </Button>
                  ) : null}
                </article>
              );
            }

            const message = item.message;
            const authorName =
              message.author === "assistant" ? m.records_side_chat_assistant() : viewerName;
            const suggestion = message.suggestion ?? null;
            const showSuggestion =
              suggestion !== null &&
              (suggestion.type === "body-edit" ||
                suggestion.type === "key-point-edit" ||
                suggestion.type === "send-prompt");
            const suggestionApplied = appliedSuggestionIds.includes(message.id);
            const suggestionDismissed = dismissedSuggestionIds.includes(message.id);
            const suggestionFrozen = suggestionApplied || suggestionDismissed;
            const preview = showSuggestion ? suggestionPreview(suggestion) : "";
            return (
              <article key={item.id} className="space-y-2">
                <div className="flex items-center gap-2">
                  <Avatar
                    size="xs"
                    alt={authorName}
                    initials={avatarInitial(authorName)}
                    contentClassName={avatarToneClassName(authorName)}
                  />
                  <span className="text-sm font-medium text-primary">{authorName}</span>
                  <span className="ml-auto text-xs text-tertiary">
                    {new Date(message.createdAt).toLocaleString()}
                  </span>
                </div>
                <p className="whitespace-pre-wrap text-sm leading-6 text-primary">{message.body}</p>
                {showSuggestion ? (
                  <div
                    className={`space-y-2 rounded-lg border p-3 ${
                      suggestionFrozen
                        ? "border-secondary bg-secondary opacity-80"
                        : "border-secondary bg-secondary"
                    }`}
                  >
                    {suggestionDismissed ? (
                      <p className="text-sm font-medium text-tertiary">
                        {m.records_assistant_suggestion_ignored()}
                      </p>
                    ) : null}
                    {suggestionApplied && !suggestionDismissed ? (
                      <p className="text-sm font-medium text-tertiary">
                        {m.records_assistant_suggestion_inserted()}
                      </p>
                    ) : null}
                    {suggestion.type === "send-prompt" ? (
                      <p className="text-sm text-secondary">{m.records_assistant_confirm_send()}</p>
                    ) : (
                      <>
                        <p className="text-sm font-medium text-primary">{suggestion.summary}</p>
                        {preview ? (
                          <div className="space-y-1">
                            <p className="text-xs font-medium text-tertiary">
                              {suggestion.type === "key-point-edit"
                                ? m.records_key_points_suggestion_preview()
                                : m.records_assistant_suggestion_preview()}
                            </p>
                            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-primary p-2 text-xs leading-5 text-secondary">
                              {preview}
                            </pre>
                          </div>
                        ) : null}
                      </>
                    )}
                    {!suggestionFrozen ? (
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          color="primary"
                          isDisabled={busy}
                          onPress={() => void confirmSuggestion(message.id, suggestion)}
                        >
                          {suggestion.type === "send-prompt"
                            ? m.records_assistant_confirm_send()
                            : suggestion.type === "key-point-edit"
                              ? m.records_key_points_insert()
                              : m.records_assistant_confirm_write()}
                        </Button>
                        <Button
                          size="sm"
                          color="tertiary"
                          isDisabled={busy}
                          onPress={() => void onIgnoreSuggestion(message.id, suggestion)}
                        >
                          {m.records_assistant_ignore_suggestion()}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </article>
            );
          })}

          {/* Keep latest bubbles above the composer so they are not flush against the edge. */}
          <div className="h-20 shrink-0" aria-hidden />
        </div>

        {awaitingSynthesis ? (
          <div className="flex items-center gap-2 border-t border-secondary px-4 py-2">
            <LoadingIndicator
              label={m.records_side_chat_assistant_running()}
              className="size-4 text-brand-secondary"
            />
            <span className="text-xs text-tertiary">{m.records_side_chat_assistant_running()}</span>
          </div>
        ) : null}

        <form onSubmit={(event) => void onSubmit(event)} className="border-t border-secondary p-3">
          <div className="flex items-end gap-2 rounded-lg border border-secondary bg-primary p-1.5 shadow-xs">
            <ButtonUtility
              type="button"
              size="sm"
              color="tertiary"
              icon={Paperclip}
              aria-label={m.records_side_chat_attach()}
              isDisabled
            />
            <TextArea
              aria-label={m.records_side_chat_placeholder()}
              value={draft}
              onChange={(value) => {
                session.draft = value;
                setDraft(value);
              }}
              onTextAreaKeyDown={onComposerKeyDown}
              onTextAreaCompositionStart={() => {
                isComposingRef.current = true;
              }}
              onTextAreaCompositionEnd={() => {
                isComposingRef.current = false;
                lastCompositionEndAtRef.current = Date.now();
              }}
              placeholder={
                sendLocked
                  ? m.records_side_chat_placeholder_busy()
                  : m.records_side_chat_placeholder()
              }
              rows={1}
              textAreaClassName="resize-none border-0 bg-transparent p-1 shadow-none ring-0 focus:ring-0"
              className="min-w-0 flex-1"
            />
            <div className="flex shrink-0 items-center gap-1">
              {countdown ? (
                <span className="mr-1 font-mono text-xs text-brand-secondary">{countdown}</span>
              ) : null}
              <ButtonUtility
                type="button"
                size="sm"
                color="tertiary"
                icon={Microphone}
                aria-label={m.records_side_chat_voice()}
                isDisabled
              />
              <ButtonUtility
                type="submit"
                size="sm"
                color="secondary"
                icon={Send}
                className="bg-brand-solid text-white hover:bg-brand-solid"
                aria-label={m.records_side_chat_send()}
                isDisabled={sendLocked || !draft.trim()}
              />
            </div>
          </div>
        </form>
      </div>

      {renameOpen ? (
        <ModalOverlay
          isOpen
          isDismissable
          onOpenChange={(next) => {
            if (!next) setRenameOpen(false);
          }}
        >
          <Modal className="w-full max-w-sm p-5">
            <Dialog className="outline-none">
              <h2 className="text-base font-semibold text-primary">
                {m.records_side_chat_rename_title()}
              </h2>
              <div className="mt-3">
                <Input
                  value={renameDraft}
                  onChange={setRenameDraft}
                  placeholder={m.records_side_chat_rename_placeholder()}
                  autoFocus
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void submitRename();
                    }
                  }}
                />
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <Button size="sm" color="secondary" onPress={() => setRenameOpen(false)}>
                  {m.controls_cancel()}
                </Button>
                <Button
                  size="sm"
                  color="primary"
                  isDisabled={!renameDraft.trim() || busy}
                  onPress={() => void submitRename()}
                >
                  {m.records_side_chat_rename_save()}
                </Button>
              </div>
            </Dialog>
          </Modal>
        </ModalOverlay>
      ) : null}
    </aside>
  );
}

function AssistantAttachmentCard({
  countdown,
}: {
  payload: Extract<RecordAssistantPayload, { kind: "offer-send" }>;
  countdown?: string | null;
}) {
  const status = countdown ?? m.records_assistant_template_ready();
  return (
    <div className="flex items-center gap-3 rounded-lg bg-brand-primary_alt px-3 py-2">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-brand-secondary">
        <FileIcon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-primary">
          {m.records_assistant_template()}
        </p>
        <p className="text-xs text-tertiary">{status}</p>
      </div>
    </div>
  );
}
