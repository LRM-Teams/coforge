import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";
import { FileIcon as FileTypeIcon } from "@untitledui/file-icons";
import { CornerUpLeft, Download01, XClose } from "@untitledui/icons";

import { getReadableFileSize } from "@/components/application/file-upload/file-upload-base";
import { Avatar } from "@/components/base/avatar/avatar";
import { Button } from "@/components/base/buttons/button";
import { Tooltip, TooltipTrigger } from "@/components/base/tooltip/tooltip";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Dialog, DialogTrigger, Modal, ModalOverlay } from "@/components/application/modals/modal";
import { AgentDisplayAvatar } from "@/features/agents/agent-activity-avatar";
import { avatarInitial, avatarToneClassName } from "@/lib/avatar-tone";
import { DELETED_AGENT_AVATAR_CLASS, DeletedAgentBadge } from "@/features/agents/deleted-agent";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";
import { ActionCard, type ActionCardView } from "./action-card";
import { AttachmentPreview } from "./attachment-preview";
import { attachmentPreviewKind } from "./attachment-preview-kind";
import { CollapsibleMessageBody } from "./collapsible-message-body";
import { formatSelectionQuote, selectionAffordancePlacement } from "./message-quote";
import { MessageReactionPicker } from "./message-reaction-picker";

export type MessageView = {
  id: string;
  sequence: number;
  threadRootId?: string;
  senderKind: "user" | "agent" | "system";
  senderMemberId?: string | null;
  /** What the reader sees: a display name, falling back to the handle (Slack's convention). */
  senderName: string;
  /** The handle behind that name, kept separate because a display name is not an identity.
   * Absent for a server-authored message. */
  senderHandle?: string;
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

/** The top edge of the visible region a floating control must stay inside: the nearest
 * scrollport ancestor's box, or the viewport top when the element is not inside a scroller. */
function visibleBoundaryTop(el: HTMLElement): number {
  let node = el.parentElement;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return node.getBoundingClientRect().top;
    node = node.parentElement;
  }
  return 0;
}

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

/**
 * The short kind shown before a file's size: its extension, or the media type when the name has no
 * usable one (`LICENSE`, `Dockerfile`, a dotfile) so such a file still says what it is rather than
 * showing a bare size. `application/octet-stream` is the upload default for "unknown", so it names
 * nothing, and a dotted phrase ("notes.final version") is not an extension.
 *
 * Not exported and not unit-tested: this is display text, and `docs/agents/testing.md` reserves UI
 * verification for a browser. The cases above are in this PR's verification Todo list instead.
 */
function attachmentTypeLabel(fileName: string, contentType: string): string | undefined {
  const dot = fileName.lastIndexOf(".");
  const suffix = dot > 0 ? fileName.slice(dot + 1) : "";
  // A long tail is part of the name rather than an extension ("notes.final version").
  if (suffix && suffix.length <= 8 && !suffix.includes(" ")) return suffix.toUpperCase();
  const subtype = contentType.split(";")[0]?.split("/")[1]?.trim() ?? "";
  const named = subtype.replace(/^(x-|vnd\.)/, "");
  if (!named || named === "octet-stream") return undefined;
  return named.slice(0, 12).toUpperCase();
}

/** An uploaded file on a message: images preview inline, other files show as a file card. */
export function AttachmentCard({ attachment }: { attachment: MessageView["attachments"][number] }) {
  const href = attachmentUrl(attachment);
  // Prefer the signed CDN preview URL so the image never round-trips the backend; fall back to
  // the authenticated proxy once (it expires after a fixed TTL, or may not be configured).
  const [previewFailed, setPreviewFailed] = useState(false);
  const previewSrc = !previewFailed && attachment.previewUrl ? attachment.previewUrl : href;
  const handlePreviewError = () => setPreviewFailed(true);
  const downloadButton = (className?: string) => (
    <ButtonUtility
      icon={Download01}
      size="xs"
      color="secondary"
      tooltip={m.conversation_attachment_download()}
      href={`${href}?download`}
      className={cn("shrink-0", className)}
    />
  );
  /** Inside a file row the control is part of the row, so it stays visible. */
  const download = downloadButton();
  /** Over an image thumbnail it covers content, so it waits for the pointer — unless the pointer
   * cannot hover, where there is nothing to wait for. */
  const downloadOverlay = downloadButton(
    "opacity-0 transition-opacity group-hover/attachment:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100",
  );
  /** Separates the file from its actions. Both row variants carry it, so a previewable file and a
   * download-only one are the same shape. */
  const actionDivider = (
    <span className="mx-1 h-8 w-px shrink-0 bg-border-secondary" aria-hidden="true" />
  );
  /** One bordered row holding the file and its actions: an IM file row rather than a wide banner.
   * Bounded width so a long name cannot stretch the bubble, and the name truncates inside it. */
  const attachmentRowClassName =
    "group/attachment mt-1 flex w-full max-w-sm min-w-0 items-center rounded-xl bg-primary ring-1 ring-secondary ring-inset";
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
        <div className="absolute top-2 right-2">{downloadOverlay}</div>
      </div>
    );
  const typeLabel = attachmentTypeLabel(attachment.fileName, attachment.contentType);
  const iconType = fileIconType(attachment.fileName, attachment.contentType);
  const previewKind = attachmentPreviewKind(
    attachment.fileName,
    attachment.contentType,
    attachment.previewUrl,
  );
  // The row owns its own flex: `Button` puts its children inside one `display: block` span, so an
  // icon and a text block handed to it directly stack vertically instead of sitting side by side.
  const card = (
    <span className="flex min-w-0 items-center gap-3">
      <FileTypeIcon className="size-10 shrink-0 dark:hidden" type={iconType} theme="light" />
      <FileTypeIcon className="size-10 shrink-0 not-dark:hidden" type={iconType} theme="dark" />
      <span className="min-w-0 text-left">
        <span className="block truncate text-sm font-medium text-secondary">
          {attachment.fileName}
        </span>
        <span className="block truncate text-xs text-tertiary">
          {typeLabel ? `${typeLabel} · ` : ""}
          {getReadableFileSize(attachment.sizeBytes)}
          {previewKind ? ` · ${m.conversation_attachment_preview_hint()}` : ""}
        </span>
      </span>
    </span>
  );
  // A file we can show reads in place instead of forcing a download: the card becomes the control
  // that opens the preview, with the download still one click away inside it. The preview lives in
  // a dialog rather than expanding inline so opening one never changes a message row's height.
  if (previewKind)
    return (
      <div className={attachmentRowClassName}>
        <DialogTrigger>
          <Button
            color="tertiary"
            noTextPadding
            aria-label={m.conversation_attachment_preview_open({ name: attachment.fileName })}
            // `Button` wraps its children in one `display: block` span of intrinsic width; without
            // `w-full min-w-0` on it the name cannot shrink, so it overflows under the download
            // control instead of truncating.
            className="h-auto min-w-0 flex-1 justify-start rounded-xl rounded-r-none p-3 hover:bg-secondary [&>span]:w-full [&>span]:min-w-0"
          >
            {card}
          </Button>
          <ModalOverlay isDismissable>
            {/* Full height on a phone (where the overlay already reserves its own padding), a
                centered panel from `sm` up. The panel owns its scrolling so the preview pane
                keeps its height instead of the whole dialog growing. */}
            <Modal className="h-full max-h-full w-full max-sm:overflow-hidden sm:h-[85vh] sm:max-w-4xl">
              <Dialog
                aria-label={attachment.fileName}
                className="flex h-full flex-col overflow-hidden"
              >
                {({ close }) => (
                  <>
                    <div className="flex shrink-0 items-center gap-2 border-b border-secondary p-3 pl-4 sm:pl-5">
                      <p className="min-w-0 flex-1 truncate text-sm font-semibold text-primary">
                        {attachment.fileName}
                      </p>
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
                    <div className="flex min-h-0 flex-1 flex-col">
                      <AttachmentPreview
                        fileName={attachment.fileName}
                        kind={previewKind}
                        href={href}
                        previewUrl={attachment.previewUrl}
                      />
                    </div>
                  </>
                )}
              </Dialog>
            </Modal>
          </ModalOverlay>
        </DialogTrigger>
        {actionDivider}
        <div className="shrink-0 pr-2">{download}</div>
      </div>
    );
  return (
    <div className={attachmentRowClassName}>
      <div className="min-w-0 flex-1 p-3">{card}</div>
      {actionDivider}
      <div className="shrink-0 pr-2">{download}</div>
    </div>
  );
}

/** The "new messages" divider (Slack-style): a brand rule naming where unread begins. */
function UnreadDivider() {
  return (
    <div
      role="separator"
      aria-label={m.conversation_unread_divider()}
      className="flex items-center gap-3 px-4 py-2 md:px-6"
    >
      {/* A neutral rule with the label at its end: the divider marks where reading resumes, so
          it has to be findable, but a coloured bar across the middle of the pane is the loudest
          thing on screen. The day divider above uses the same rule. */}
      <span aria-hidden="true" className="h-px flex-1 bg-secondary" />
      <span className="shrink-0 text-xs text-brand-secondary">
        {m.conversation_unread_divider()}
      </span>
    </div>
  );
}

/** A row is a plain flow item: its height is whatever its content needs, and nothing — neither
 * this file nor the conversation around it — estimates that height in advance.
 *
 * Off-screen skipping (`content-visibility: auto` with `contain-intrinsic-size: auto 160px`) was
 * tried here and removed: it gives every never-rendered row a 160px placeholder, and prepending
 * older history at the top of the pane then forces a batch of those placeholders to resolve to
 * their real heights inside the viewport. The resulting shift re-triggers scroll anchoring, which
 * changes which rows count as near the viewport, which lays out more of them — a feedback loop
 * that pins the main thread until the renderer is killed. */
const ROW_CLASS = "flex flex-col";

/** One history row: optional day divider, then the message with its hover actions. */
export function MessageRow({
  message,
  own,
  dayChanged,
  grouped,
  expanded,
  onToggleExpanded,
  agentDisplay,
  unreadStartsHere,
  dateLocale,
  threadEntry,
  threadPreview,
  messageFooter,
  onToggleReaction,
  onOpenAgentProfile,
  viewerHandle,
  onQuoteSelection,
}: {
  message: MessageView;
  own: boolean;
  dayChanged: boolean;
  grouped: boolean;
  /** Whether this message's very long body is showing in full. Owned by the conversation rather
   * than the row, so a row that re-renders (or is skipped and rendered again as you scroll) never
   * collapses behind the reader. */
  expanded: boolean;
  onToggleExpanded: () => void;
  /** The live display snapshot for one Agent, from the app shell's subscription. Absent where the
   * surface has no access to it; the avatar then renders without a dot rather than as a wrong one. */
  agentDisplay?: (agentId: string) => AgentDisplaySnapshot | undefined;
  /** The conversation's unread run begins at this row (ADR 0046): draws the divider above. */
  unreadStartsHere?: boolean;
  dateLocale?: string;
  threadEntry?: (message: MessageView) => ReactNode;
  threadPreview?: (message: MessageView) => ReactNode;
  messageFooter?: (message: MessageView) => ReactNode;
  /** Toggles the viewer's own emoji reaction on a message; the conversation refreshes it. */
  onToggleReaction?: (messageId: string, emoji: string, active: boolean) => void;
  /** Opens the Agent profile panel; present only where the conversation owns that slot
   * (`features/agents/profile-panel/`'s `openAgentProfile`). Absent, the avatar/name render inert. */
  onOpenAgentProfile?: (agentId: string) => void;
  /** The viewing user's handle; a mention of it renders with the stronger "me" chip. */
  viewerHandle?: string;
  /** Offers "reply to this selection" on a highlight inside this row's body: the row hands back
   * the finished markdown quote, credited to the message it came from. Absent (e.g. the
   * conversation has no composer to put it in), no affordance is offered and no selection is
   * read at all. */
  onQuoteSelection?: (quote: string) => void;
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
  // An Agent's avatar in the stream carries the same online/working/thinking/error/offline dot the
  // sidebar, conversation header and @-mention popup use, so you can tell whether the Agent that
  // wrote a message is around right now without opening its profile. The snapshot comes from the
  // app shell's one subscription, looked up by the conversation and passed in. A person has no
  // presence in the product, so a person's avatar stays plain; a deleted Agent shows no dot
  // either (`AgentDisplayAvatar` greys it and drops the dot) — a deletion is not a presence state.
  const avatar =
    message.senderKind === "agent" && message.senderAgentId ? (
      <AgentDisplayAvatar
        name={message.senderName}
        src={message.senderAvatarUrl}
        display={agentDisplay?.(message.senderAgentId)}
        deleted={deleted}
        size="sm"
      />
    ) : (
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
  // Reply-to-selection: the browser owns the highlight, this row only decides whether to *offer*
  // the action. The offer is made from a completed pointer gesture, so a drag that merely passes
  // over this message while selecting another one never raises it.
  const bodyRef = useRef<HTMLDivElement>(null);
  const quoteAffordanceRef = useRef<HTMLDivElement>(null);
  const [quoteOffer, setQuoteOffer] = useState<
    { quote: string; top: number; left: number } | undefined
  >(undefined);
  /**
   * Reads the current highlight, and offers the quote only when the whole selection lives inside
   * this message's body: a highlight that spans rows cannot be credited to one of them, and a
   * quote that silently dropped half the selected text would be worse than no affordance.
   */
  const readQuoteSelection = useCallback(() => {
    if (!onQuoteSelection) return;
    const container = bodyRef.current;
    const selection = typeof window === "undefined" ? null : window.getSelection();
    if (!container || !selection || selection.isCollapsed || selection.rangeCount === 0) {
      setQuoteOffer(undefined);
      return;
    }
    const range = selection.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) {
      setQuoteOffer(undefined);
      return;
    }
    const quote = formatSelectionQuote(
      { author: displayName, time: clockLabel(message.createdAt, dateLocale) },
      selection.toString(),
    );
    if (!quote) {
      setQuoteOffer(undefined);
      return;
    }
    // Anchored above the highlight and centered on it; the visible history scroller is the flip
    // boundary, so the button only drops below the highlight when it would scroll out of view.
    const placement = selectionAffordancePlacement(
      range.getBoundingClientRect(),
      container.getBoundingClientRect(),
      { top: visibleBoundaryTop(container) },
    );
    setQuoteOffer({ quote, ...placement });
  }, [onQuoteSelection, displayName, message.createdAt, dateLocale]);
  // A gesture anywhere else (a click, a scroll, Escape) withdraws the offer. The affordance
  // itself is exempt: pointerdown on it would otherwise unmount the button before its click.
  useEffect(() => {
    if (!quoteOffer) return;
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && quoteAffordanceRef.current?.contains(event.target))
        return;
      setQuoteOffer(undefined);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss(event);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [quoteOffer]);
  // A system message (task/membership notices, etc.) is not a person talking: it carries no
  // avatar and no sender heading, and renders as a compact, muted line in the stream — like
  // Slack's channel notices. The body still goes through `MessageBody` so a `@handle` mention in
  // it stays a resolved chip. The wrapper (`li`) is the same in both branches, so a system row
  // costs the browser exactly what a normal one does.
  if (message.senderKind === "system") {
    return (
      <li data-message-id={message.id} className={ROW_CLASS}>
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
          data-message="system"
          className="group/message flex scroll-m-6 items-baseline gap-2 px-4 py-1 text-xs text-tertiary md:px-6"
        >
          {/* System bodies are short plain text (task/membership notices, authored with a plain
              `@handle`, not a mention token), so they render as a single muted line rather than
              full Markdown. */}
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{message.body}</span>
          <time
            dateTime={new Date(message.createdAt).toISOString()}
            className="shrink-0 tabular-nums opacity-0 group-hover/message:opacity-100"
          >
            {clockLabel(message.createdAt, dateLocale)}
          </time>
        </div>
      </li>
    );
  }
  return (
    <li data-message-id={message.id} className={ROW_CLASS}>
      {unreadStartsHere && <UnreadDivider />}
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
            // `relative` anchors the reply-to-selection affordance to the body it was highlighted
            // out of; the gesture handlers live here rather than on the row so dragging from a
            // message's text (its timestamp, say) cannot raise an offer for it.
            <div
              ref={bodyRef}
              onMouseUp={readQuoteSelection}
              onKeyUp={readQuoteSelection}
              className={cn(
                "relative min-w-0 text-md leading-6 text-primary [overflow-wrap:anywhere]",
                grouped && threadEntry && "pr-8",
              )}
            >
              <CollapsibleMessageBody
                body={message.body}
                mentions={message.mentions}
                viewerHandle={viewerHandle}
                onOpenAgentProfile={onOpenAgentProfile}
                expanded={expanded}
                onToggleExpanded={onToggleExpanded}
              />
              {quoteOffer && onQuoteSelection && (
                <div
                  ref={quoteAffordanceRef}
                  style={{ top: quoteOffer.top, left: quoteOffer.left }}
                  className="absolute z-10"
                >
                  <ButtonUtility
                    size="xs"
                    color="secondary"
                    icon={CornerUpLeft}
                    tooltip={m.conversation_quote_selection()}
                    className="border border-secondary bg-primary shadow-lg"
                    onClick={() => {
                      onQuoteSelection(quoteOffer.quote);
                      setQuoteOffer(undefined);
                    }}
                  />
                </div>
              )}
            </div>
          )}
          {message.attachments.map((attachment) => (
            <AttachmentCard key={attachment.id} attachment={attachment} />
          ))}
          {message.reactions && message.reactions.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-0.5">
              {message.reactions.map((reaction) => {
                // The summaries spell a reactor as `@handle`; a badge counts as mine when it
                // carries the viewer's own handle, and flips to brand to show it.
                const mine = viewerHandle ? reaction.reactors.includes(`@${viewerHandle}`) : false;
                return (
                  <Tooltip key={reaction.emoji} title={reaction.reactors.join(", ")}>
                    <TooltipTrigger>
                      <Button
                        color="tertiary"
                        size="sm"
                        noTextPadding
                        onPress={() => onToggleReaction?.(message.id, reaction.emoji, !mine)}
                        aria-pressed={mine}
                        className={cn(
                          "h-auto rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
                          mine
                            ? "bg-utility-brand-50 text-utility-brand-700 ring-utility-brand-200 hover:bg-utility-brand-100"
                            : "bg-utility-neutral-50 text-utility-neutral-700 ring-utility-neutral-200 hover:bg-utility-neutral-100",
                        )}
                      >
                        {reaction.emoji} {reaction.count}
                      </Button>
                    </TooltipTrigger>
                  </Tooltip>
                );
              })}
            </div>
          )}
          {messageFooter?.(message)}
          {threadPreview?.(message)}
        </div>
        {(threadEntry || onToggleReaction) && (
          <div className="absolute top-0.5 right-3 flex items-center gap-0.5 rounded-lg border border-secondary bg-primary p-0.5 opacity-0 shadow-lg transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100 has-[[data-thread-unread]]:opacity-100 [@media(hover:none)]:opacity-100 [@media(any-pointer:coarse)]:opacity-100">
            {threadEntry?.(message)}
            {onToggleReaction && (
              <MessageReactionPicker
                onPick={(emoji) => onToggleReaction(message.id, emoji, true)}
              />
            )}
          </div>
        )}
      </div>
    </li>
  );
}
