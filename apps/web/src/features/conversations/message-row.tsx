import type { ReactNode, Ref } from "react";
import { FileIcon } from "@untitledui/file-icons";

import { Avatar } from "@/components/base/avatar/avatar";
import { avatarInitial, avatarToneClassName } from "@/lib/avatar-tone";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";

export type MessageView = {
  id: string;
  sequence: number;
  threadRootId?: string;
  senderKind: "user" | "agent" | "system";
  senderMemberId?: string | null;
  senderName: string;
  body: string;
  createdAt: Date | string;
  attachment?: { id: string; fileName: string; contentType: string; sizeBytes: number };
};

const GROUPING_WINDOW_MS = 5 * 60 * 1000;

// Intl.DateTimeFormat construction dominates per-row formatting cost; keep one per locale.
const dayFormatters = new Map<string, Intl.DateTimeFormat>();
const clockFormatters = new Map<string, Intl.DateTimeFormat>();
function cachedFormatter(
  cache: Map<string, Intl.DateTimeFormat>,
  locale: string,
  options: Intl.DateTimeFormatOptions,
) {
  let formatter = cache.get(locale);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options);
    cache.set(locale, formatter);
  }
  return formatter;
}

export function dayLabel(value: Date | string, locale?: string): string {
  // Keep server/first-client markup identical; browser locale and zone apply after mount.
  if (!locale) return new Date(value).toISOString().slice(0, 10);
  return cachedFormatter(dayFormatters, locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

export function clockLabel(value: Date | string, locale?: string): string {
  if (!locale) return "";
  return cachedFormatter(clockFormatters, locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

/** Whether two consecutive messages collapse into one visual group. */
export function groupsWithPrevious(
  message: MessageView,
  previous: MessageView | undefined,
  own: boolean,
  previousOwn: boolean,
  locale?: string,
) {
  if (!previous) return { dayChanged: true, grouped: false };
  const dayChanged = dayLabel(previous.createdAt, locale) !== dayLabel(message.createdAt, locale);
  const sameSender =
    !dayChanged &&
    previousOwn === own &&
    (previous.senderMemberId ?? previous.senderName) ===
      (message.senderMemberId ?? message.senderName);
  const grouped =
    sameSender &&
    Math.abs(new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime()) <=
      GROUPING_WINDOW_MS;
  return { dayChanged, grouped };
}

export function AttachmentCard({
  attachment,
}: {
  attachment: NonNullable<MessageView["attachment"]>;
}) {
  return (
    <a
      href={`/api/attachments/${attachment.id}`}
      target="_blank"
      rel="noreferrer"
      className="mt-1 flex w-fit max-w-full min-w-0 items-center gap-2 rounded-lg border border-secondary px-2.5 py-2 hover:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
    >
      <FileIcon
        aria-hidden="true"
        type={attachment.contentType || "empty"}
        variant="gray"
        size={24}
        className="shrink-0"
      />
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <span className="truncate text-sm font-medium text-primary">{attachment.fileName}</span>
        <span className="text-xs text-tertiary">{Math.ceil(attachment.sizeBytes / 1024)} KB</span>
      </span>
    </a>
  );
}

/** One virtualized history row: optional day divider, then the message with its hover actions. */
export function MessageRow({
  message,
  index,
  own,
  dayChanged,
  grouped,
  offset,
  dateLocale,
  measureRef,
  threadEntry,
  threadPreview,
  messageFooter,
}: {
  message: MessageView;
  index: number;
  own: boolean;
  dayChanged: boolean;
  grouped: boolean;
  /** Vertical position inside the list, from the virtualizer. */
  offset: number;
  dateLocale?: string;
  measureRef: Ref<HTMLLIElement>;
  threadEntry?: (message: MessageView) => ReactNode;
  threadPreview?: (message: MessageView) => ReactNode;
  messageFooter?: (message: MessageView) => ReactNode;
}) {
  const displayName = own ? m.conversation_you() : message.senderName;
  return (
    <li
      data-message-id={message.id}
      data-index={index}
      ref={measureRef}
      className="absolute top-0 left-0 flex w-full flex-col"
      style={{ transform: `translateY(${offset}px)` }}
    >
      {dayChanged && (
        <div className="flex items-center gap-3 px-4 py-2 md:px-6">
          <span aria-hidden="true" className="h-px flex-1 bg-secondary" />
          <span className="shrink-0 bg-primary px-2 text-xs text-tertiary tabular-nums">
            {dayLabel(message.createdAt, dateLocale)}
          </span>
          <span aria-hidden="true" className="h-px flex-1 bg-secondary" />
        </div>
      )}
      <div
        id={`message-${message.id}`}
        data-message={own ? "own" : "other"}
        className={cn(
          "group/message relative flex scroll-m-6 gap-3 px-4 transition-[background-color,box-shadow] duration-500 hover:bg-secondary focus-within:bg-secondary target:bg-active target:ring-2 target:ring-brand/50 target:ring-offset-4 target:ring-offset-primary md:px-6",
          grouped ? "py-0.5" : "py-2",
        )}
      >
        <div className="flex w-9 shrink-0 items-start justify-center">
          {grouped ? (
            <time
              dateTime={new Date(message.createdAt).toISOString()}
              className="mt-0.5 text-xs text-quaternary tabular-nums opacity-0 group-hover/message:opacity-100 group-focus-within/message:opacity-100"
            >
              {clockLabel(message.createdAt, dateLocale)}
            </time>
          ) : (
            <Avatar
              size="sm"
              alt={message.senderName}
              initials={avatarInitial(message.senderName)}
              contentClassName={avatarToneClassName(message.senderName)}
            />
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {!grouped && (
            <p className="flex min-h-5 items-baseline gap-2 pr-8">
              <span className="min-w-0 truncate text-sm font-semibold text-primary">
                {displayName}
              </span>
              <time
                dateTime={new Date(message.createdAt).toISOString()}
                className="shrink-0 text-xs text-tertiary tabular-nums"
              >
                {clockLabel(message.createdAt, dateLocale)}
              </time>
            </p>
          )}
          <div
            className={cn(
              "min-w-0 text-md leading-6 whitespace-pre-wrap text-primary [overflow-wrap:anywhere]",
              grouped && threadEntry && "pr-8",
            )}
          >
            {message.body}
          </div>
          {message.attachment && <AttachmentCard attachment={message.attachment} />}
          {messageFooter?.(message)}
          {threadPreview?.(message)}
        </div>
        {threadEntry && (
          <div className="absolute top-0.5 right-3 flex items-center opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100 [@media(hover:none)]:opacity-100 [@media(any-pointer:coarse)]:opacity-100">
            {threadEntry(message)}
          </div>
        )}
      </div>
    </li>
  );
}
