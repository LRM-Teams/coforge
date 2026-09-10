import { useEffect, useState, type FormEvent } from "react";
import { useServerFn } from "@tanstack/react-start";
import { XClose as X } from "@untitledui/icons";

import { Avatar } from "@/components/base/avatar/avatar";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { TextArea } from "@/components/base/textarea/textarea";
import { avatarInitial, avatarToneClassName } from "@/lib/avatar-tone";
import { m } from "@/paraglide/messages";
import { addRecordComment, loadRecordComments } from "./records.functions";

type CommentRow = Awaited<ReturnType<typeof loadRecordComments>>[number];

/**
 * Side panel for human comments on a record subject.
 * `assistant` / `system` authorType rows render read-only for future AI cards.
 */
export function RecordSidePanel({
  subjectType,
  subjectId,
  onClose,
}: {
  subjectType: "report" | "highlight" | "cycle";
  subjectId: string;
  onClose: () => void;
}) {
  const load = useServerFn(loadRecordComments);
  const post = useServerFn(addRecordComment);
  const [comments, setComments] = useState<CommentRow[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const rows = await load({ data: { subjectType, subjectId } });
    setComments(rows);
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const rows = await load({ data: { subjectType, subjectId } });
      if (!cancelled) setComments(rows);
    })();
    return () => {
      cancelled = true;
    };
  }, [subjectType, subjectId, load]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await post({ data: { subjectType, subjectId, body } });
      setDraft("");
      await refresh();
    } finally {
      setBusy(false);
    }
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
            return (
              <article key={comment.id} className="space-y-1.5">
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
              </article>
            );
          })
        )}
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
          <Button type="submit" size="sm" isDisabled={busy || !draft.trim()}>
            {m.records_side_chat_send()}
          </Button>
        </div>
      </form>
    </aside>
  );
}
