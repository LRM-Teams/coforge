import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Check, Plus } from "@untitledui/icons";
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
  availableActions: readonly "add"[];
};

type MentionActionResult = Awaited<ReturnType<typeof executeMentionActions>>[number];

/** How long an added row stays to show it was added, then how long it takes to fade out. */
const ADDED_VISIBLE_MS = 450;
const ADDED_REMOVE_MS = 750;

/**
 * Above the composer, one row per person or Agent the reader's last message mentioned but who is
 * not in the channel, so was not notified: Add makes them a member, Ignore only hides the row.
 * With more than one row to add, Add all adds them in one request. An added row says so, then
 * fades out; a refusal is explained in a sentence under the rows.
 */
export function PendingMentionStrip({
  mentions,
  onRemove,
}: {
  mentions: readonly PendingMention[];
  onRemove: (resolutionId: string) => void;
}) {
  const execute = useServerFn(executeMentionActions);
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());
  const [adding, setAdding] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState("");
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const addable = mentions
    .filter((mention) => mention.availableActions.includes("add"))
    .map((mention) => mention.resolutionId)
    .filter((id) => !added.has(id) && !leaving.has(id));

  function showAdded(ids: readonly string[]) {
    setAdded((current) => new Set([...current, ...ids]));
    timers.current.push(
      setTimeout(() => setLeaving((current) => new Set([...current, ...ids])), ADDED_VISIBLE_MS),
      setTimeout(() => ids.forEach(onRemove), ADDED_REMOVE_MS),
    );
  }

  async function add(ids: readonly string[]) {
    setAdding((current) => new Set([...current, ...ids]));
    setError("");
    try {
      const results = await execute({ data: { action: "add", resolutionIds: [...ids] } });
      const delivered = results.filter((result) => result.status === "delivered");
      const refused = results.find((result) => result.status !== "delivered");
      if (delivered.length) showAdded(delivered.map((result) => result.resolutionId));
      if (refused)
        setError(
          ids.length > 1 && delivered.length
            ? m.conversation_pending_mention_added_partial({
                succeeded: delivered.length,
                total: ids.length,
                reason: refusalText(refused),
              })
            : refusalText(refused),
        );
    } catch {
      setError(m.conversation_pending_mention_add_failed());
    } finally {
      setAdding((current) => new Set([...current].filter((id) => !ids.includes(id))));
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg bg-secondary px-2 py-2">
      <ul className="flex flex-col gap-2">
        {mentions.map((mention) => {
          const wasAdded = added.has(mention.resolutionId);
          const canAdd = mention.availableActions.includes("add") && !wasAdded;
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
              <p className="min-w-0 flex-1 text-sm text-secondary">
                {wasAdded
                  ? m.conversation_pending_mention_added({ target, channel })
                  : m.conversation_pending_mention_not_notified({ target, channel })}
              </p>
              <div className="ml-auto flex shrink-0 items-center gap-1">
                {wasAdded ? (
                  <span className="inline-flex items-center gap-1 px-2 text-sm font-semibold text-tertiary">
                    <Check aria-hidden="true" className="size-4" />
                    {m.conversation_pending_mention_added_label()}
                  </span>
                ) : (
                  <>
                    {canAdd && (
                      <Button
                        size="xs"
                        color="secondary"
                        iconLeading={Plus}
                        isLoading={adding.has(mention.resolutionId)}
                        onClick={() => void add([mention.resolutionId])}
                      >
                        {m.conversation_pending_mention_add()}
                      </Button>
                    )}
                    <Button
                      size="xs"
                      color="link-gray"
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
            onClick={() => void add(addable)}
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
