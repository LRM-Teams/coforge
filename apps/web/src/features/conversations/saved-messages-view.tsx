import { Link, useRouter } from "@tanstack/react-router";
import { Bookmark, BookmarkCheck, Copy01, Link01, MessageTextSquare01 } from "@untitledui/icons";
import { Link as AriaLink } from "react-aria-components";

import { Avatar } from "#src/components/base/avatar/avatar";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { PageHeader } from "#src/components/layout/page-header";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#src/components/ui/empty";
import { RelativeTime } from "#src/components/ui/relative-time";
import { useAppToast } from "#src/components/ui/toast";
import { copyText } from "#src/features/records/report-editor/lib/clipboard";
import { m } from "#src/paraglide/messages";
import { useSavedEntries, useSavedMessages } from "./conversation-navigation";
import { savedJumpTarget } from "./saved-messages-model";
import type { SavedEntry } from "./saved-messages-collection";
import { messagePlainText } from "./selection-copy";

/**
 * The Saved view (#127). A card jumps back to the message's position in its conversation — a
 * thread reply lands on its root's row and the thread stays closed (position-only `?message=`,
 * not the notification deep link's `#message-<id>` hash; see `saved-messages-model`). The trailing
 * bookmark unsaves in one click, without a confirm: it is instantly reversible and the card
 * disappearing is the confirmation (docs/design/toast-vs-inline.md §13).
 */
export function SavedMessagesView() {
  const saved = useSavedMessages();
  const entries = useSavedEntries() ?? [];
  if (!saved) return null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        heading={m.conversation_saved_nav()}
        meta={
          <span className="shrink-0 text-sm text-tertiary">
            {m.conversation_saved_count({ count: entries.length })}
          </span>
        }
      />
      {entries.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Bookmark aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>{m.conversation_saved_empty_title()}</EmptyTitle>
              <EmptyDescription>{m.conversation_saved_empty_description()}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      ) : (
        <ol className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-4">
          {entries.map((entry) => (
            <SavedMessageCard key={entry.message.id} entry={entry} onUnsave={saved.unsave} />
          ))}
        </ol>
      )}
    </div>
  );
}

function SavedMessageCard({
  entry,
  onUnsave,
}: {
  entry: SavedEntry;
  /** Takes the card away at once; rejects (after putting it back) when the server refuses. */
  onUnsave: (messageId: string) => Promise<void>;
}) {
  const router = useRouter();
  const toast = useAppToast();
  const { conversation, message } = entry;
  const jump = savedJumpTarget(conversation, message);
  // The localized URL (`publicHref`), the one the card links to and the address bar shows.
  const href = router.buildLocation(jump).publicHref;
  const place = conversation.channelName
    ? `#${conversation.channelName}`
    : `@${message.senderName}`;
  const attachmentName = message.attachments[0]?.fileName;

  function remove() {
    void onUnsave(message.id).catch(() => toast.error(m.conversation_save_failed()));
  }

  function copy(text: string, success: string) {
    void copyText(text).then((copied) => {
      if (copied) toast.success(success);
      else toast.error(m.conversation_copy_failed());
    });
  }

  function handleAction(key: unknown) {
    if (key === "copy-link") {
      copy(new URL(href, window.location.origin).href, m.conversation_saved_link_copied());
    } else if (key === "copy-markdown" && message.body) {
      // Markdown source as typed, with mentions and task references spelled out.
      copy(
        messagePlainText({ body: message.body, mentions: message.mentions }),
        m.conversation_copy_as_markdown_success(),
      );
    } else if (key === "remove") {
      remove();
    }
  }

  return (
    // No native text selection or iOS link callout competing with the menu a long-press opens.
    <li className="flex items-start gap-2 rounded-xl border border-secondary bg-primary p-3 transition-colors select-none [-webkit-touch-callout:none] hover:bg-secondary">
      {/* The card is a React Aria link so the context menu (`MenuTrigger trigger="contextMenu"`)
          can use it as its trigger; `render` hands the element to TanStack's `Link`, which owns
          navigation (react-aria.adobe.com/Link, client-side routing). A left click stays an
          ordinary jump. */}
      <Dropdown.Root trigger="contextMenu">
        <AriaLink
          href={href}
          render={(props) =>
            "href" in props ? <Link {...props} {...jump} /> : <span {...props} />
          }
          className="min-w-0 flex-1 rounded-lg outline-focus-ring focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          <div className="flex min-w-0 items-center gap-2 text-xs text-tertiary">
            <span className="truncate font-medium text-tertiary">{place}</span>
            {message.threadRootId && (
              <span className="inline-flex shrink-0 items-center gap-1 text-quaternary">
                <MessageTextSquare01 aria-hidden="true" className="size-3" />
                {m.conversation_thread()}
              </span>
            )}
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <Avatar
                size="xs"
                src={message.senderAvatarUrl ?? null}
                alt=""
                className="size-4 shrink-0"
              />
              <span className="truncate font-semibold text-secondary">{message.senderName}</span>
            </span>
            <RelativeTime value={message.createdAt} />
          </div>
          {/* Every card is the same size: a plain-text excerpt in one type size, always two lines
              tall, the rest hidden. */}
          <p className="mt-1 line-clamp-2 h-10 text-sm leading-5 break-words text-secondary">
            {message.body
              ? messagePlainText({ body: message.body, mentions: message.mentions })
              : (attachmentName ?? "")}
          </p>
        </AriaLink>
        <Dropdown.Popover placement="bottom start">
          <Dropdown.Menu aria-label={m.conversation_message_actions()} onAction={handleAction}>
            <Dropdown.Item
              id="copy-link"
              icon={Link01}
              label={m.conversation_saved_copy_link()}
              selectionIndicator="none"
            />
            <Dropdown.Item
              id="copy-markdown"
              icon={Copy01}
              label={m.conversation_copy_as_markdown()}
              selectionIndicator="none"
              isDisabled={!message.body}
            />
            <Dropdown.Separator />
            <Dropdown.Item
              id="remove"
              icon={BookmarkCheck}
              label={m.conversation_unsave()}
              selectionIndicator="none"
            />
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown.Root>
      <ButtonUtility
        icon={BookmarkCheck}
        size="xs"
        color="tertiary"
        tooltip={m.conversation_unsave()}
        aria-label={m.conversation_unsave()}
        onClick={remove}
        className="shrink-0"
      />
    </li>
  );
}
