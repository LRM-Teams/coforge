import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  File02 as FileIcon,
  Microphone02 as Microphone,
  Paperclip,
  Send01 as Send,
  XClose as X,
} from "@untitledui/icons";

import { Avatar } from "@/components/base/avatar/avatar";
import { useSendWindowCountdown } from "./use-send-window";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { TextArea } from "@/components/base/textarea/textarea";
import { avatarInitial, avatarToneClassName } from "@/lib/avatar-tone";
import { m } from "@/paraglide/messages";
import type { WeeklyReportAssistantSuggestion } from "../../server/records/weekly-report-assistant-suggestion.server";
import type { HighlightContent, ReportContent } from "./records-content";
import {
  addRecordComment,
  applyConfirmedWeeklyHighlight,
  applyConfirmedWeeklyReportBody,
  ensureRecordAssistantIntro,
  generateWeeklyHighlights,
  loadWeeklyReportAssistantContext,
  loadWeeklyReportAssistantMessages,
  loadWeeklyReportAssistantStatus,
  postWeeklyReportAssistantRequest,
} from "./records.functions";
import {
  looksLikeGenerateHighlightsRequest,
  parseRecordAssistantPayload,
  type HighlightMemberCandidate,
  type RecordAssistantPayload,
} from "./weekly-highlight-extract";
import {
  createWeeklyReportAssistantSessionStore,
  weeklyReportAssistantSubjectKey,
  type WeeklyReportAssistantMessage,
} from "./weekly-report-assistant-session";

type CommentRow = Awaited<ReturnType<typeof ensureRecordAssistantIntro>>[number];

export type RecordSideSurface = "format" | "member-leader" | "highlight" | "plain";

function payloadOf(comment: CommentRow): RecordAssistantPayload | null {
  return parseRecordAssistantPayload(comment.payload);
}

function assistantReady(
  status: Awaited<ReturnType<typeof loadWeeklyReportAssistantStatus>> | null,
) {
  return Boolean(status?.computerConfigured && status.runtimeConfigured);
}

function suggestionPreview(suggestion: WeeklyReportAssistantSuggestion): string {
  if (suggestion.type === "send-prompt") return "";
  if (suggestion.type === "body-edit") {
    const tabs = suggestion.content.tabs ?? {};
    return Object.entries(tabs)
      .map(([name, tab]) => `## ${name}\n${tab.markdown.trimEnd()}`)
      .join("\n\n");
  }
  return suggestion.content.blocks
    .map((block) => {
      const items = block.items
        .map((item) => `- ${typeof item === "string" ? item : item.text}`)
        .join("\n");
      const paragraphs = block.paragraphs.join("\n");
      return [`### ${block.heading}`, paragraphs, items].filter(Boolean).join("\n");
    })
    .join("\n\n");
}

export function RecordSidePanel({
  subjectType,
  subjectId,
  surface,
  formatCopy,
  countdownUntil,
  refreshToken = 0,
  onRequestSend,
  onClose,
}: {
  subjectType: "report" | "highlight" | "cycle";
  subjectId: string;
  surface: RecordSideSurface;
  formatCopy?: "preview" | "cancelled" | "ready";
  /** End of the open send window; the panel renders the countdown itself. */
  countdownUntil?: Date | null;
  refreshToken?: number;
  onRequestSend?: () => void;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const router = useRouter();
  const countdown = useSendWindowCountdown(countdownUntil);
  const post = useServerFn(addRecordComment);
  const ensureIntro = useServerFn(ensureRecordAssistantIntro);
  const generate = useServerFn(generateWeeklyHighlights);
  const loadAssistantContext = useServerFn(loadWeeklyReportAssistantContext);
  const loadAssistantStatus = useServerFn(loadWeeklyReportAssistantStatus);
  const loadAssistantMessages = useServerFn(loadWeeklyReportAssistantMessages);
  const postAssistantRequest = useServerFn(postWeeklyReportAssistantRequest);
  const applyBody = useServerFn(applyConfirmedWeeklyReportBody);
  const applyHighlight = useServerFn(applyConfirmedWeeklyHighlight);
  const [sessionStore] = useState(createWeeklyReportAssistantSessionStore);
  const sessionKey = weeklyReportAssistantSubjectKey(subjectType, subjectId);
  const session = sessionStore.get(sessionKey);
  const [comments, setComments] = useState<CommentRow[]>([]);
  const [assistantMessages, setAssistantMessages] = useState<WeeklyReportAssistantMessage[]>(
    session.messages,
  );
  const [assistantStatus, setAssistantStatus] = useState<Awaited<
    ReturnType<typeof loadWeeklyReportAssistantStatus>
  > | null>(null);
  const [setupDismissed, setSetupDismissed] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(session.error);
  const [picker, setPicker] = useState<HighlightMemberCandidate[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [dismissedSuggestionIds, setDismissedSuggestionIds] = useState<string[]>(
    session.dismissedSuggestionIds,
  );

  useEffect(() => {
    setComments([]);
    setAssistantMessages(session.messages);
    setDraft(session.draft);
    setSetupDismissed(session.setupDismissed);
    setError(session.error);
    setPicker(null);
    setPicked([]);
    setDismissedSuggestionIds(session.dismissedSuggestionIds);
  }, [sessionKey]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [rows, status, context, chat] = await Promise.all([
        ensureIntro({ data: { subjectType, subjectId, surface, formatCopy } }),
        loadAssistantStatus().catch(() => null),
        loadAssistantContext({ data: { subjectType, subjectId } }).catch(() => null),
        loadAssistantMessages({ data: { subjectType, subjectId } }).catch(() => null),
      ]);
      if (!cancelled) {
        setComments(rows);
        setAssistantStatus(status);
        session.contextManifest = context;
        if (chat) {
          const messages = chat.messages.map((message) => ({
            id: message.id,
            body: message.displayBody,
            author: message.author,
            suggestion: message.suggestion,
          }));
          session.messages = messages;
          setAssistantMessages(messages);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    subjectType,
    subjectId,
    surface,
    formatCopy,
    ensureIntro,
    loadAssistantContext,
    loadAssistantMessages,
    loadAssistantStatus,
    refreshToken,
    session,
  ]);

  function dismissSuggestion(messageId: string) {
    const next = [...new Set([...session.dismissedSuggestionIds, messageId])];
    session.dismissedSuggestionIds = next;
    setDismissedSuggestionIds(next);
  }

  async function confirmSuggestion(messageId: string, suggestion: WeeklyReportAssistantSuggestion) {
    if (busy) return;
    if (suggestion.type === "send-prompt") {
      dismissSuggestion(messageId);
      onRequestSend?.();
      return;
    }
    setBusy(true);
    setError(null);
    session.error = null;
    try {
      if (suggestion.type === "body-edit") {
        await applyBody({
          data: {
            reportId: suggestion.reportId,
            content: suggestion.content as ReportContent,
          },
        });
      } else {
        const result = await applyHighlight({
          data: {
            cycleId: suggestion.cycleId,
            highlightId: suggestion.highlightId,
            content: suggestion.content as HighlightContent,
            markCompleted: suggestion.markCompleted,
          },
        });
        if (subjectType !== "highlight" || subjectId !== result.highlightId) {
          await router.invalidate({ sync: true });
          void navigate({
            to: "/records/$recordId",
            params: { recordId: result.highlightId },
            search: { tab: "weekly" },
          });
        }
      }
      dismissSuggestion(messageId);
      await router.invalidate({ sync: true });
    } catch {
      const message = m.records_assistant_write_failed();
      session.error = message;
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    session.error = null;
    try {
      const useRulePath =
        looksLikeGenerateHighlightsRequest(body) || !assistantReady(assistantStatus);
      if (useRulePath) {
        if (!assistantReady(assistantStatus) && !looksLikeGenerateHighlightsRequest(body)) {
          session.setupDismissed = false;
          setSetupDismissed(false);
        }
        const rows = await post({ data: { subjectType, subjectId, body } });
        session.draft = "";
        setDraft("");
        setComments(rows);
        const last = rows.at(-1);
        const payload = last ? payloadOf(last) : null;
        if (payload?.kind === "pick-members") {
          setPicker(payload.members);
          setPicked(
            payload.members.filter((member) => member.submitted).map((member) => member.userId),
          );
        }
        return;
      }

      const result = await postAssistantRequest({
        data: {
          subjectType,
          subjectId,
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
        const last = result.comments.at(-1);
        const payload = last ? payloadOf(last) : null;
        if (payload?.kind === "pick-members") {
          setPicker(payload.members);
          setPicked(
            payload.members.filter((member) => member.submitted).map((member) => member.userId),
          );
        }
        return;
      }

      session.draft = "";
      setDraft("");
      const chat = await loadAssistantMessages({ data: { subjectType, subjectId } });
      const refreshed = chat.messages.map((message) => ({
        id: message.id,
        body: message.displayBody,
        author: message.author,
        suggestion: message.suggestion,
      }));
      session.messages = refreshed;
      setAssistantMessages(refreshed);
    } catch {
      const message = m.records_weekly_ai_request_failed();
      session.error = message;
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  async function runGenerate(memberIds: "all" | string[]) {
    if (subjectType !== "report" || busy) return;
    setBusy(true);
    try {
      const result = await generate({ data: { reportId: subjectId, memberIds } });
      await router.invalidate({ sync: true });
      void navigate({
        to: "/records/$recordId",
        params: { recordId: result.highlightId },
        search: { tab: "weekly" },
      });
    } finally {
      setBusy(false);
    }
  }

  function showPicker(members: HighlightMemberCandidate[]) {
    setPicker(members);
    setPicked(members.filter((member) => member.submitted).map((member) => member.userId));
  }

  const totalCount = comments.length + assistantMessages.length;

  return (
    <aside className="flex w-full max-w-sm shrink-0 flex-col border-l border-secondary bg-primary">
      <div className="flex items-center justify-between border-b border-secondary px-4 py-3">
        <div className="text-sm font-semibold text-primary">
          {m.records_side_chat()}{" "}
          <span className="font-normal text-tertiary">
            {m.records_side_chat_count({ count: totalCount })}
          </span>
        </div>
        <ButtonUtility
          size="sm"
          color="tertiary"
          icon={X}
          aria-label={m.controls_close()}
          onClick={onClose}
        />
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
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
                to="/agents/$agentId"
                params={{ agentId: assistantStatus.agentId }}
                search={{ tab: "profile", edit: true }}
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
        {error ? <p className="text-sm text-error-primary">{error}</p> : null}
        {comments.length === 0 && assistantMessages.length === 0 ? (
          <p className="text-sm text-tertiary">{m.records_side_chat_empty()}</p>
        ) : null}
        {comments.map((comment) => {
          const authorName =
            comment.authorType === "assistant"
              ? m.records_side_chat_assistant()
              : comment.authorType === "system"
                ? m.records_side_chat_system()
                : (comment.author?.displayName ?? m.records_side_chat_user());
          const payload = payloadOf(comment);
          return (
            <article key={comment.id} className="space-y-2">
              <div className="flex items-center gap-2">
                <Avatar
                  size="xs"
                  alt={authorName}
                  initials={avatarInitial(authorName)}
                  contentClassName={avatarToneClassName(authorName)}
                />
                <span className="text-sm font-medium text-primary">{authorName}</span>
                <span className="ml-auto text-xs text-tertiary">
                  {new Date(comment.createdAt).toLocaleString()}
                </span>
              </div>
              <p className="whitespace-pre-wrap text-sm leading-6 text-primary">{comment.body}</p>
              {payload?.kind === "offer-send" || payload?.kind === "generated" ? (
                <AssistantAttachmentCard payload={payload} countdown={countdown} />
              ) : null}
              {payload?.kind === "offer-generate" ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    color="secondary"
                    isDisabled={busy || payload.members.every((member) => !member.submitted)}
                    onPress={() => void runGenerate("all")}
                  >
                    {m.records_assistant_generate_all()}
                  </Button>
                  <Button
                    size="sm"
                    color="secondary"
                    isDisabled={busy}
                    onPress={() => showPicker(payload.members)}
                  >
                    {m.records_assistant_pick_members()}
                  </Button>
                </div>
              ) : null}
              {payload?.kind === "pick-members" ? (
                <Button
                  size="sm"
                  color="secondary"
                  isDisabled={busy}
                  onPress={() => showPicker(payload.members)}
                >
                  {m.records_assistant_pick_members()}
                </Button>
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
              {payload?.kind === "generated" ? (
                <Link
                  to="/records/$recordId"
                  params={{ recordId: payload.highlightId }}
                  search={{ tab: "weekly" }}
                  className="text-sm font-medium text-brand-secondary"
                >
                  {m.records_assistant_open_highlight()}
                </Link>
              ) : null}
            </article>
          );
        })}

        {assistantMessages.map((message) => {
          const authorName =
            message.author === "assistant"
              ? m.records_side_chat_assistant()
              : m.records_side_chat_user();
          const suggestion = message.suggestion ?? null;
          const showSuggestion =
            suggestion !== null && !dismissedSuggestionIds.includes(message.id);
          const preview = showSuggestion ? suggestionPreview(suggestion) : "";
          return (
            <article key={message.id} className="space-y-2">
              <div className="flex items-center gap-2">
                <Avatar
                  size="xs"
                  alt={authorName}
                  initials={avatarInitial(authorName)}
                  contentClassName={avatarToneClassName(authorName)}
                />
                <span className="text-sm font-medium text-primary">{authorName}</span>
              </div>
              <p className="whitespace-pre-wrap text-sm leading-6 text-primary">{message.body}</p>
              {showSuggestion ? (
                <div className="space-y-2 rounded-lg border border-secondary bg-secondary p-3">
                  {suggestion.type !== "send-prompt" ? (
                    <>
                      <p className="text-sm font-medium text-primary">{suggestion.summary}</p>
                      {preview ? (
                        <div className="space-y-1">
                          <p className="text-xs font-medium text-tertiary">
                            {m.records_assistant_suggestion_preview()}
                          </p>
                          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-primary p-2 text-xs leading-5 text-secondary">
                            {preview}
                          </pre>
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <p className="text-sm text-secondary">{m.records_assistant_confirm_send()}</p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      color="primary"
                      isDisabled={busy}
                      onPress={() => void confirmSuggestion(message.id, suggestion)}
                    >
                      {suggestion.type === "send-prompt"
                        ? m.records_assistant_confirm_send()
                        : m.records_assistant_confirm_write()}
                    </Button>
                    <Button
                      size="sm"
                      color="tertiary"
                      isDisabled={busy}
                      onPress={() => dismissSuggestion(message.id)}
                    >
                      {m.records_assistant_ignore_suggestion()}
                    </Button>
                  </div>
                </div>
              ) : null}
            </article>
          );
        })}

        {picker ? (
          <div className="space-y-3 rounded-lg border border-secondary bg-primary p-3 shadow-xs">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-primary">
                {m.records_assistant_pick_members()} ({picker.length})
              </p>
              <Button
                size="sm"
                isDisabled={busy || picked.length === 0}
                onPress={() => void runGenerate(picked)}
              >
                {m.records_assistant_confirm_generate()}
              </Button>
            </div>
            <ul className="max-h-72 space-y-1 overflow-y-auto">
              {picker.map((member) => (
                <li key={member.userId}>
                  <div className="flex items-center gap-2 rounded-md px-1 py-1.5">
                    <Checkbox
                      size="sm"
                      isDisabled={!member.submitted || busy}
                      isSelected={picked.includes(member.userId)}
                      onChange={(selected) => {
                        setPicked((current) =>
                          selected
                            ? [...current, member.userId]
                            : current.filter((id) => id !== member.userId),
                        );
                      }}
                      aria-label={member.displayName}
                    />
                    <Avatar
                      size="xs"
                      initials={avatarInitial(member.displayName)}
                      contentClassName={avatarToneClassName(member.displayName)}
                    />
                    <span className="min-w-0 flex-1 truncate text-sm text-primary">
                      {member.displayName}
                    </span>
                    {!member.submitted ? (
                      <span className="shrink-0 text-xs text-tertiary">
                        {m.records_report_unread_badge()}
                      </span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

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
            placeholder={m.records_side_chat_placeholder()}
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
              isDisabled={busy || !draft.trim()}
            />
          </div>
        </div>
      </form>
    </aside>
  );
}

function AssistantAttachmentCard({
  payload,
  countdown,
}: {
  payload: Extract<RecordAssistantPayload, { kind: "offer-send" | "generated" }>;
  countdown?: string | null;
}) {
  const status =
    payload.kind === "generated"
      ? m.records_assistant_template_generated()
      : (countdown ?? m.records_assistant_template_ready());
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
