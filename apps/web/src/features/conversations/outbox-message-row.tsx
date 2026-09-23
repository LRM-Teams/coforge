import { useEffect, useState } from "react";
import { getRouteApi } from "@tanstack/react-router";
import { AlertCircle, Paperclip } from "@untitledui/icons";

import { Avatar } from "#src/components/base/avatar/avatar";
import { Button } from "#src/components/base/buttons/button";
import { avatarInitial, avatarToneClassName } from "#src/lib/avatar-tone";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import {
  unsentReasonAllowsEdit,
  unsentReasonAllowsRetry,
  type OutboxEntry,
  type UnsentReason,
} from "./composer-outbox";
import type { ChipMention } from "./message-markdown";
import { MessageBody } from "./message-body";
import { canEditUnsent, failureAnnounced, failureNeedsAnnouncing } from "./use-message-outbox";

const appRoute = getRouteApi("/_app");

/** How long a send may stay unconfirmed before its row also says "Sending…". Shorter sends just
 * show greyed, so a normal send never flashes a label; a longer one says plainly that it has not
 * gone through yet, so a greyed message is never mistaken for a sent one. */
const SLOW_SEND_MS = 3000;

function unsentReasonText(reason: UnsentReason): string {
  switch (reason) {
    case "offline":
      return m.conversation_unsent_offline();
    case "unavailable":
      return m.conversation_unsent_unavailable();
    case "interrupted":
      return m.conversation_unsent_interrupted();
    case "denied":
      return m.conversation_unsent_denied();
    case "gone":
      return m.conversation_unsent_gone();
    case "rejected":
      return m.conversation_unsent_rejected();
  }
}

/** The failure sentence. It announces itself to screen readers only when the failure has just
 * happened on this page (`failureNeedsAnnouncing`), once. */
function UnsentReasonText({ localId, reason }: { localId: string; reason: UnsentReason }) {
  const [announce] = useState(() => failureNeedsAnnouncing(localId));
  useEffect(() => {
    if (announce) failureAnnounced(localId);
  }, [announce, localId]);
  return (
    <span role={announce ? "alert" : undefined} className="text-error-primary">
      {unsentReasonText(reason)}
    </span>
  );
}

function useSlowSend(pending: boolean) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!pending) return;
    const timer = setTimeout(() => setSlow(true), SLOW_SEND_MS);
    return () => clearTimeout(timer);
  }, [pending]);
  return pending && slow;
}

/**
 * One of the viewer's own messages the server has not confirmed yet, at the foot of the
 * conversation: greyed from the moment it is submitted, the real message taking its place once the
 * server has it. A failed send stays here, greyed, with the reason in the reader's words and what
 * can be done about it.
 */
export function OutboxMessageRow({
  entry,
  grouped,
  composerShown,
  plainMentions,
  viewerHandle,
  taskReferences,
  onOpenTask,
  channelReferences,
  onRetry,
  onEdit,
  onDiscard,
}: {
  entry: OutboxEntry;
  /** Continues the viewer's run of messages right above, so no avatar or name repeats. */
  grouped: boolean;
  /** Whether the chat shows a composer that "Edit" could put the message back into. */
  composerShown: boolean;
  plainMentions?: Map<string, ChipMention>;
  viewerHandle?: string;
  /** The pending row renders the same body markup as a delivered one: a `task #N` reference
   * keeps its chip (clickable, same popup) instead of degrading to plain text for the send. */
  taskReferences?: ReadonlySet<number>;
  onOpenTask?: (number: number) => void;
  channelReferences?: ReadonlyMap<string, string>;
  onRetry: () => void;
  onEdit: () => void;
  onDiscard: () => void;
}) {
  const viewer = appRoute.useLoaderData({ select: (data) => data.user });
  const unsent = entry.state === "unsent" ? entry : undefined;
  const slow = useSlowSend(entry.state === "sending");
  const sendingLabel = slow && (
    <span className="shrink-0 text-xs text-tertiary">{m.conversation_sending()}</span>
  );
  return (
    <li data-outbox-state={entry.state} className="flex flex-col">
      <div className={cn("flex gap-3 px-4 md:px-6", grouped ? "py-0.5" : "py-2")}>
        <div className="flex w-9 shrink-0 items-start justify-center">
          {!grouped && (
            <Avatar
              size="sm"
              alt=""
              src={viewer.avatarUrl}
              initials={avatarInitial(viewer.name)}
              contentClassName={avatarToneClassName(viewer.name)}
            />
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {!grouped && (
            <p className="flex min-h-5 items-baseline gap-2 pr-8">
              <span className="min-w-0 truncate text-sm font-semibold text-primary">
                {m.conversation_you()}
              </span>
              {sendingLabel}
            </p>
          )}
          <div className="min-w-0 text-md leading-6 text-quaternary [overflow-wrap:anywhere]">
            <MessageBody
              body={entry.body}
              plainMentions={plainMentions}
              viewerHandle={viewerHandle}
              taskReferences={taskReferences}
              onOpenTask={onOpenTask}
              channelReferences={channelReferences}
            />
          </div>
          {entry.attachments.length > 0 && (
            <ul className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-quaternary">
              {entry.attachments.map((attachment) => (
                <li key={attachment.id} className="flex min-w-0 items-center gap-1">
                  <Paperclip aria-hidden="true" className="size-4 shrink-0" />
                  <span className="truncate">{attachment.fileName}</span>
                </li>
              ))}
            </ul>
          )}
          {grouped && sendingLabel}
          {unsent && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <AlertCircle aria-hidden="true" className="size-4 shrink-0 text-fg-error-primary" />
              <UnsentReasonText localId={entry.localId} reason={unsent.reason} />
              {unsentReasonAllowsRetry(unsent.reason) && (
                <>
                  <span aria-hidden="true" className="text-quaternary">
                    ·
                  </span>
                  <Button color="link-color" size="sm" onPress={onRetry}>
                    {m.controls_retry()}
                  </Button>
                </>
              )}
              {composerShown && unsentReasonAllowsEdit(unsent.reason) && canEditUnsent(entry) && (
                <>
                  <span aria-hidden="true" className="text-quaternary">
                    ·
                  </span>
                  <Button color="link-gray" size="sm" onPress={onEdit}>
                    {m.conversation_unsent_edit()}
                  </Button>
                </>
              )}
              <span aria-hidden="true" className="text-quaternary">
                ·
              </span>
              <Button color="link-destructive" size="sm" onPress={onDiscard}>
                {m.conversation_unsent_discard()}
              </Button>
            </div>
          )}
          {unsent?.errorId && (
            <p className="pl-6 text-xs text-tertiary">
              {m.error_reference({ errorId: unsent.errorId })}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}
