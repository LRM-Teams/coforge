import { useState, type ReactNode, type Ref } from "react";
import { FileIcon as FileTypeIcon } from "@untitledui/file-icons";
import { Download01, XClose } from "@untitledui/icons";

import { getReadableFileSize } from "@/components/application/file-upload/file-upload-base";
import { Avatar } from "@/components/base/avatar/avatar";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Tooltip, TooltipTrigger } from "@/components/base/tooltip/tooltip";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Dialog, DialogTrigger, Modal, ModalOverlay } from "@/components/application/modals/modal";
import { avatarInitial, avatarToneClassName } from "@/lib/avatar-tone";
import { DELETED_AGENT_AVATAR_CLASS, DeletedAgentBadge } from "@/features/agents/deleted-agent";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";
import { ActionCard, type ActionCardView } from "./action-card";
import { MessageBody } from "./message-body";

export type MessageView = {
  id: string;
  sequence: number;
  threadRootId?: string;
  senderKind: "user" | "agent" | "system";
  senderMemberId?: string | null;
  senderName: string;
  /** The sender's Agent id, present only when `senderKind === "agent"`; opens the Agent profile
   * panel (`features/agents/profile-panel/`) from the avatar or the sender name. */
  senderAgentId?: string;
  /** True when the sending Agent has since been deleted (ADR 0044): the sender renders greyed
   * with a `DELETED` marker, and no longer opens that Agent's profile. */
  senderDeleted?: boolean;
  senderAvatarUrl?: string | null;
  body: string;
  createdAt: Date | string;
  /** Always present, possibly empty; order matches send/upload order. */
  attachments: {
    id: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
    /** Short-lived signed CDN URL for an inline image; see `attachmentView` on the server.
     * Preferred over `attachmentUrl` when present so `<img>` never round-trips the backend. */
    previewUrl?: string;
  }[];
  /** Resolved mention rows for the body's embedded `<@kind:uuid>` tokens; absent/empty for
   * DMs and pre-token history, which render as written (token-only highlight by design). */
  mentions?: {
    kind: "user" | "agent";
    actorId: string;
    handle: string;
    label: string;
  }[];
  reactions?: { emoji: string; count: number; reactors: string[] }[];
  /** Present when this message is the summary posted for an Agent-prepared action card
   * (ADR 0027). Replaces the plain-text draft hint line with the interactive card; the
   * underlying `body` stays available to assistive technology. */
  actionCard?: ActionCardView;
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

// The file-type icons the icon set ships, by extension.
const FILE_ICON_TYPES = new Set([
  "aep",
  "ai",
  "avi",
  "css",
  "csv",
  "dmg",
  "doc",
  "docx",
  "eps",
  "exe",
  "fig",
  "gif",
  "html",
  "indd",
  "java",
  "jpeg",
  "jpg",
  "js",
  "json",
  "mkv",
  "mp3",
  "mp4",
  "mpeg",
  "pdf",
  "png",
  "ppt",
  "pptx",
  "psd",
  "rar",
  "rss",
  "sql",
  "svg",
  "tiff",
  "txt",
  "wav",
  "webp",
  "xls",
  "xlsx",
  "xml",
  "zip",
]);

/** The icon-set type for a file: its extension when there is a dedicated icon, else its media kind. */
export function fileIconType(fileName: string, contentType: string) {
  const extension = fileName.includes(".") ? fileName.split(".").pop()!.toLowerCase() : "";
  if (FILE_ICON_TYPES.has(extension)) return extension;
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType.startsWith("text/")) return "txt";
  return "empty";
}

/** The authenticated backend fallback: forced downloads, and inline images once their signed
 * CDN preview URL has expired or fails to load (the route then redirects to a fresh one, or
 * streams the bytes when CDN delivery is not configured). */
export function attachmentUrl(attachment: { id: string }) {
  return `/api/attachments/${attachment.id}`;
}

/** An uploaded file on a message: images preview inline, other files show as a file card. */
export function AttachmentCard({ attachment }: { attachment: MessageView["attachments"][number] }) {
  const href = attachmentUrl(attachment);
  // Prefer the signed CDN preview URL so the image never round-trips the backend; fall back to
  // the authenticated proxy once (it expires after a fixed TTL, or may not be configured).
  const [previewFailed, setPreviewFailed] = useState(false);
  const previewSrc = !previewFailed && attachment.previewUrl ? attachment.previewUrl : href;
  const handlePreviewError = () => setPreviewFailed(true);
  const download = (
    <ButtonUtility
      icon={Download01}
      size="xs"
      color="secondary"
      tooltip={m.conversation_attachment_download()}
      href={`${href}?download`}
      className="shrink-0 opacity-0 transition-opacity group-hover/attachment:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
    />
  );
  if (attachment.contentType.startsWith("image/"))
    return (
      <div className="group/attachment relative mt-1 w-fit max-w-full">
        {/* Clicking the preview opens the image at full size in a lightbox. */}
        <DialogTrigger>
          <Button
            color="tertiary"
            noTextPadding
            aria-label={attachment.fileName}
            className="block h-auto overflow-hidden rounded-lg p-0 ring-1 ring-secondary ring-inset hover:bg-transparent"
          >
            <img
              src={previewSrc}
              onError={handlePreviewError}
              alt={attachment.fileName}
              loading="lazy"
              className="block max-h-80 max-w-full object-contain"
            />
          </Button>
          <ModalOverlay isDismissable>
            {/* The lightbox fills the viewport: the action bar owns a top strip so it pins to the
                page's top-right corner and never overlaps the image, even for viewport-filling
                images; the image is centered in the remaining space below. */}
            <Modal className="h-full w-full max-w-full bg-transparent shadow-none">
              <Dialog aria-label={attachment.fileName} className="h-full">
                {({ close }) => {
                  // The modal covers the whole overlay, so backdrop dismissal is handled here:
                  // pressing a backdrop area itself (not the image or the actions) closes,
                  // matching ModalOverlay's dismiss behavior.
                  const dismissOnBackdrop = (event: React.PointerEvent) => {
                    if (event.target === event.currentTarget) close();
                  };
                  return (
                    <div className="flex h-full w-full flex-col">
                      <div
                        className="flex shrink-0 justify-end p-4"
                        onPointerDown={dismissOnBackdrop}
                      >
                        <div className="flex items-center gap-1 rounded-lg bg-primary/90 p-1 shadow-xs">
                          <ButtonUtility
                            icon={Download01}
                            size="sm"
                            color="tertiary"
                            tooltip={m.conversation_attachment_download()}
                            href={`${href}?download`}
                          />
                          <ButtonUtility
                            icon={XClose}
                            size="sm"
                            color="tertiary"
                            tooltip={m.controls_close()}
                            onClick={close}
                          />
                        </div>
                      </div>
                      <div
                        className="flex min-h-0 flex-1 items-center justify-center"
                        onPointerDown={dismissOnBackdrop}
                      >
                        <img
                          src={previewSrc}
                          onError={handlePreviewError}
                          alt={attachment.fileName}
                          className="block max-h-full max-w-[min(96vw,80rem)] rounded-lg object-contain"
                        />
                      </div>
                    </div>
                  );
                }}
              </Dialog>
            </Modal>
          </ModalOverlay>
        </DialogTrigger>
        <div className="absolute top-2 right-2">{download}</div>
      </div>
    );
  const extension = attachment.fileName.split(".").pop()?.toUpperCase();
  const iconType = fileIconType(attachment.fileName, attachment.contentType);
  return (
    <div className="group/attachment mt-1 flex w-fit max-w-full min-w-0 items-center gap-3 rounded-xl bg-primary p-3 pr-2 ring-1 ring-secondary ring-inset">
      <FileTypeIcon className="size-10 shrink-0 dark:hidden" type={iconType} theme="light" />
      <FileTypeIcon className="size-10 shrink-0 not-dark:hidden" type={iconType} theme="dark" />
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-secondary">{attachment.fileName}</p>
        <p className="text-sm text-tertiary">
          {extension && extension !== attachment.fileName.toUpperCase() ? `${extension} · ` : ""}
          {getReadableFileSize(attachment.sizeBytes)}
        </p>
      </div>
      {download}
    </div>
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
  onOpenAgentProfile,
  viewerHandle,
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
  /** Opens the Agent profile panel; present only where the conversation owns that slot
   * (`features/agents/profile-panel/`'s `openAgentProfile`). Absent, the avatar/name render inert. */
  onOpenAgentProfile?: (agentId: string) => void;
  /** The viewing user's handle; a mention of it renders with the stronger "me" chip. */
  viewerHandle?: string;
}) {
  const displayName = own ? m.conversation_you() : message.senderName;
  const deleted = Boolean(message.senderDeleted);
  const openableAgentId =
    !own &&
    !deleted &&
    message.senderKind === "agent" &&
    message.senderAgentId &&
    onOpenAgentProfile
      ? message.senderAgentId
      : undefined;
  // A deleted sender is inert and visually muted: no profile affordance, a grey avatar tone, and
  // a `DELETED` badge beside the name (ADR 0044).
  const avatar = (
    <Avatar
      size="sm"
      alt=""
      src={message.senderAvatarUrl}
      initials={avatarInitial(message.senderName)}
      contentClassName={
        deleted ? DELETED_AGENT_AVATAR_CLASS : avatarToneClassName(message.senderName)
      }
    />
  );
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
          ) : openableAgentId ? (
            <Button
              color="tertiary"
              noTextPadding
              aria-label={m.agent_open_profile({ name: message.senderName })}
              onPress={() => onOpenAgentProfile?.(openableAgentId)}
              className="h-auto w-auto min-w-0 rounded-full p-0 hover:bg-transparent"
            >
              {avatar}
            </Button>
          ) : (
            avatar
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {!grouped && (
            <p className="flex min-h-5 items-baseline gap-2 pr-8">
              {openableAgentId ? (
                <Button
                  color="tertiary"
                  noTextPadding
                  onPress={() => onOpenAgentProfile?.(openableAgentId)}
                  className="h-auto min-w-0 truncate rounded p-0 text-sm font-semibold text-primary hover:bg-transparent hover:text-primary hover:underline"
                >
                  {displayName}
                </Button>
              ) : (
                <span className="min-w-0 truncate text-sm font-semibold text-primary">
                  {displayName}
                </span>
              )}
              {deleted && <DeletedAgentBadge />}
              <time
                dateTime={new Date(message.createdAt).toISOString()}
                className="shrink-0 text-xs text-tertiary tabular-nums"
              >
                {clockLabel(message.createdAt, dateLocale)}
              </time>
            </p>
          )}
          {message.actionCard ? (
            <>
              {/* The raw summary (and draft hint) stay accessible; the card renders them. */}
              <span className="sr-only">{message.body}</span>
              <ActionCard card={message.actionCard} />
            </>
          ) : (
            <div
              className={cn(
                // No `whitespace-pre-wrap`: soft breaks are real `<br>` now (remark-breaks), so
                // preserving literal newlines as well would double every line gap.
                "min-w-0 text-md leading-6 text-primary [overflow-wrap:anywhere]",
                grouped && threadEntry && "pr-8",
              )}
            >
              <MessageBody
                body={message.body}
                mentions={message.mentions}
                viewerHandle={viewerHandle}
                onOpenAgentProfile={onOpenAgentProfile}
              />
            </div>
          )}
          {message.attachments.map((attachment) => (
            <AttachmentCard key={attachment.id} attachment={attachment} />
          ))}
          {message.reactions && message.reactions.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-0.5">
              {message.reactions.map((reaction) => (
                <Tooltip key={reaction.emoji} title={reaction.reactors.join(", ")}>
                  <TooltipTrigger>
                    <Badge size="sm" color="gray">
                      {reaction.emoji} {reaction.count}
                    </Badge>
                  </TooltipTrigger>
                </Tooltip>
              ))}
            </div>
          )}
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
