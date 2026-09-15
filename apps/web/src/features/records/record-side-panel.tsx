import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { XClose as X } from "@untitledui/icons";

import { Avatar } from "@/components/base/avatar/avatar";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { TextArea } from "@/components/base/textarea/textarea";
import { avatarInitial, avatarToneClassName } from "@/lib/avatar-tone";
import { m } from "@/paraglide/messages";
import {
  addRecordComment,
  ensureRecordAssistantIntro,
  generateWeeklyHighlights,
} from "./records.functions";
import {
  parseRecordAssistantPayload,
  type HighlightMemberCandidate,
  type RecordAssistantPayload,
} from "./weekly-highlight-extract";

type CommentRow = Awaited<ReturnType<typeof ensureRecordAssistantIntro>>[number];

export type RecordSideSurface = "format" | "member-leader" | "highlight" | "plain";

function payloadOf(comment: CommentRow): RecordAssistantPayload | null {
  return parseRecordAssistantPayload(comment.payload);
}

export function RecordSidePanel({
  subjectType,
  subjectId,
  surface,
  formatCopy,
  countdown,
  refreshToken = 0,
  onRequestSend,
  onClose,
}: {
  subjectType: "report" | "highlight" | "cycle";
  subjectId: string;
  surface: RecordSideSurface;
  formatCopy?: "preview" | "cancelled" | "ready";
  countdown?: string | null;
  refreshToken?: number;
  onRequestSend?: () => void;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const router = useRouter();
  const post = useServerFn(addRecordComment);
  const ensureIntro = useServerFn(ensureRecordAssistantIntro);
  const generate = useServerFn(generateWeeklyHighlights);
  const [comments, setComments] = useState<CommentRow[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState<HighlightMemberCandidate[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const rows = await ensureIntro({
        data: { subjectType, subjectId, surface, formatCopy },
      });
      if (!cancelled) setComments(rows);
    })();
    return () => {
      cancelled = true;
    };
  }, [subjectType, subjectId, surface, formatCopy, ensureIntro, refreshToken]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      const rows = await post({ data: { subjectType, subjectId, body } });
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

  return (
    <aside className="flex w-full max-w-sm shrink-0 flex-col border-l border-secondary bg-primary">
      <div className="flex items-center justify-between border-b border-secondary px-4 py-3">
        <div className="text-sm font-semibold text-primary">
          {m.records_side_chat()}{" "}
          <span className="font-normal text-tertiary">
            {m.records_side_chat_count({ count: comments.length })}
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
        {comments.length === 0 ? (
          <p className="text-sm text-tertiary">{m.records_side_chat_empty()}</p>
        ) : (
          comments.map((comment) => {
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
                <p className="whitespace-pre-wrap text-sm text-primary">{comment.body}</p>
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
          })
        )}

        {picker ? (
          <div className="space-y-3 rounded-xl border border-secondary p-3">
            <p className="text-sm font-medium text-primary">{m.records_assistant_pick_members()}</p>
            <ul className="space-y-2">
              {picker.map((member) => (
                <li key={member.userId}>
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
                    label={member.displayName}
                    hint={member.submitted ? undefined : m.records_report_unread_badge()}
                  />
                </li>
              ))}
            </ul>
            <Button
              size="sm"
              isDisabled={busy || picked.length === 0}
              onPress={() => void runGenerate(picked)}
            >
              {m.records_assistant_confirm_generate()}
            </Button>
          </div>
        ) : null}
      </div>

      <form onSubmit={(event) => void onSubmit(event)} className="border-t border-secondary p-3">
        <div className="flex items-end gap-2">
          <TextArea
            aria-label={m.records_side_chat_placeholder()}
            value={draft}
            onChange={setDraft}
            placeholder={m.records_side_chat_placeholder()}
            rows={2}
            className="flex-1"
          />
          <div className="flex flex-col items-end gap-1">
            {countdown ? (
              <span className="font-mono text-xs text-brand-secondary">{countdown}</span>
            ) : null}
            <Button type="submit" size="sm" isDisabled={busy || !draft.trim()}>
              {m.records_side_chat_send()}
            </Button>
          </div>
        </div>
      </form>
    </aside>
  );
}
