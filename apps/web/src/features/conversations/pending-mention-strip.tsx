import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Bell01, Check, Plus } from "@untitledui/icons";
import { Avatar } from "#src/components/base/avatar/avatar";
import { Button } from "#src/components/base/buttons/button";
import { avatarInitial, avatarToneClassName } from "#src/lib/avatar-tone";
import { cx } from "#src/utils/cx";
import { m } from "#src/paraglide/messages";
import { executeMentionActions } from "./channels.functions";

/** One mention of the reader's own message that did not reach someone outside the channel. */
export type PendingMention = {
  resolutionId: string;
  targetType: "user" | "agent";
  targetHandle: string;
  targetLabel: string;
  targetAvatarUrl: string | null;
  channelName: string;
  availableActions: readonly ("notify" | "add")[];
  /** What the reader's Notify or Add did: kept by the composer, so it survives leaving the chat. */
  outcome?: MentionOutcome;
};

type MentionActionResult = Awaited<ReturnType<typeof executeMentionActions>>[number];

/** Added or notified rows say so, then fade out; a refused row stays with no action to repeat. */
export type MentionOutcome = "added" | "notified" | "refused";

/** The result status that means an action reached its target. */
const COMPLETED_STATUS = { notify: "queued", add: "delivered" } as const;

/** How long an added row stays to show it was added, then how long it takes to fade out. */
const ADDED_VISIBLE_MS = 450;
const ADDED_REMOVE_MS = 750;

/**
 * Above the composer, one row per person or Agent the reader's last message mentioned but who is
 * not in the channel, so was not notified: Notify has them read that one message, Add makes them a
 * member, Ignore only hides the row. With more than one row to add, Add all adds them in one
 * request. A notified or added row says so, then fades out; a refusal is explained in a sentence
 * under the rows.
 */
export function PendingMentionStrip({
  mentions,
  onSettle,
  onRemove,
}: {
  mentions: readonly PendingMention[];
  onSettle: (resolutionIds: readonly string[], outcome: MentionOutcome) => void;
  onRemove: (resolutionId: string) => void;
}) {
  const execute = useServerFn(executeMentionActions);
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());
  const [adding, setAdding] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState("");
  // A notified or added row shows so, then fades out and goes, each on its own timers.
  // Scheduled from what the composer kept, so a row added just before the reader left the chat
  // still goes on return.
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>[]>());
  const remove = useEffectEvent((resolutionId: string) => onRemove(resolutionId));
  const addedKey = mentions
    .filter((mention) => mention.outcome === "added" || mention.outcome === "notified")
    .map((mention) => mention.resolutionId)
    .join(",");
  useEffect(() => {
    for (const id of addedKey ? addedKey.split(",") : []) {
      if (timers.current.has(id)) continue;
      timers.current.set(id, [
        setTimeout(() => setLeaving((current) => new Set([...current, id])), ADDED_VISIBLE_MS),
        setTimeout(() => remove(id), ADDED_REMOVE_MS),
      ]);
    }
  }, [addedKey]);
  useEffect(() => {
    const scheduled = timers.current;
    return () => {
      for (const ids of scheduled.values()) ids.forEach(clearTimeout);
      scheduled.clear();
    };
  }, []);

  const addable = mentions
    .filter((mention) => mention.availableActions.includes("add") && !mention.outcome)
    .map((mention) => mention.resolutionId);

  async function act(action: "notify" | "add", ids: readonly string[]) {
    setAdding((current) => new Set([...current, ...ids]));
    setError("");
    try {
      const results = await execute({ data: { action, resolutionIds: [...ids] } });
      const done = results.filter((result) => result.status === COMPLETED_STATUS[action]);
      const refusals = results.filter((result) => result.status !== COMPLETED_STATUS[action]);
      const refused = refusals[0];
      if (done.length)
        onSettle(
          done.map((result) => result.resolutionId),
          action === "add" ? "added" : "notified",
        );
      if (refusals.length)
        onSettle(
          refusals.map((result) => result.resolutionId),
          "refused",
        );
      if (refused)
        setError(
          ids.length > 1 && done.length
            ? m.conversation_pending_mention_added_partial({
                succeeded: done.length,
                total: ids.length,
                reason: refusalText(refused),
              })
            : refusalText(refused),
        );
    } catch {
      setError(
        action === "add"
          ? m.conversation_pending_mention_add_failed()
          : m.conversation_pending_mention_notify_failed(),
      );
    } finally {
      setAdding((current) => new Set([...current].filter((id) => !ids.includes(id))));
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg bg-secondary px-2 py-2">
      <ul className="flex flex-col gap-2">
        {mentions.map((mention) => {
          const settled = mention.outcome === "added" || mention.outcome === "notified";
          const canNotify = mention.availableActions.includes("notify") && !mention.outcome;
          const canAdd = mention.availableActions.includes("add") && !mention.outcome;
          const busy = adding.has(mention.resolutionId);
          const target = `@${mention.targetHandle}`;
          const channel = `#${mention.channelName}`;
          return (
            <li
              key={mention.resolutionId}
              className={cx(
                "flex flex-wrap items-center gap-x-2 gap-y-1 transition-opacity duration-300 motion-reduce:transition-none",
                leaving.has(mention.resolutionId) && "opacity-0",
              )}
            >
              <Avatar
                size="xs"
                alt=""
                src={mention.targetAvatarUrl}
                initials={avatarInitial(mention.targetLabel)}
                contentClassName={avatarToneClassName(mention.targetLabel)}
              />
              <p role="status" className="min-w-0 flex-1 text-sm text-secondary">
                {mention.outcome === "added"
                  ? m.conversation_pending_mention_added({ target, channel })
                  : mention.outcome === "notified"
                    ? m.conversation_pending_mention_queued({ target, channel })
                    : m.conversation_pending_mention_not_notified({ target, channel })}
              </p>
              <div className="ml-auto flex shrink-0 items-center gap-1">
                {settled ? (
                  <span className="inline-flex items-center gap-1 px-2 text-sm font-semibold text-tertiary">
                    <Check aria-hidden="true" className="size-4" />
                    {mention.outcome === "added"
                      ? m.conversation_pending_mention_added_label()
                      : m.conversation_pending_mention_queued_label()}
                  </span>
                ) : (
                  <>
                    {canAdd && (
                      <Button
                        size="xs"
                        color="secondary"
                        iconLeading={Plus}
                        isLoading={busy}
                        aria-label={m.conversation_pending_mention_add_target({ target })}
                        onClick={() => void act("add", [mention.resolutionId])}
                      >
                        {m.conversation_pending_mention_add()}
                      </Button>
                    )}
                    {canNotify && (
                      <Button
                        size="xs"
                        color="secondary"
                        iconLeading={Bell01}
                        isDisabled={busy}
                        aria-label={m.conversation_pending_mention_notify_target({ target })}
                        onClick={() => void act("notify", [mention.resolutionId])}
                      >
                        {m.conversation_pending_mention_notify()}
                      </Button>
                    )}
                    <Button
                      size="xs"
                      color="link-gray"
                      aria-label={m.conversation_pending_mention_ignore_target({ target })}
                      onClick={() => onRemove(mention.resolutionId)}
                    >
                      {m.conversation_pending_mention_ignore()}
                    </Button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {addable.length > 1 && (
        <div className="flex justify-end border-t border-secondary pt-2">
          <Button
            size="xs"
            color="secondary"
            iconLeading={Plus}
            isLoading={addable.some((id) => adding.has(id))}
            onClick={() => void act("add", addable)}
          >
            {m.conversation_pending_mention_add_all()}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-error-primary">
          {error}
        </p>
      )}
    </div>
  );
}

/** Why one mention action was refused, in the reader's words. */
function refusalText(result: MentionActionResult): string {
  switch (result.reason) {
    case "target_already_member":
      return m.conversation_pending_mention_already_member();
    case "target_unavailable":
      return m.conversation_pending_mention_target_unavailable();
    case "sender_lacks_channel_access":
      return m.conversation_pending_mention_sender_lacks_access();
    case "channel_archived":
      return m.conversation_pending_mention_channel_archived();
    case "no_longer_pending":
      return m.conversation_pending_mention_no_longer_pending();
  }
  return result.status === "expired"
    ? m.conversation_pending_mention_expired()
    : m.conversation_pending_mention_unavailable();
}
