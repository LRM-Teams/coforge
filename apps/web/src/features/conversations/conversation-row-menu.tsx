import { Fragment, useState, type ReactNode } from "react";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { MessageChatSquare, Pin01, XClose } from "@untitledui/icons";

import { Button } from "@/components/base/buttons/button";
import { Dropdown } from "@/components/base/dropdown/dropdown";
import { useAppToast } from "@/components/ui/toast";
import { m } from "@/paraglide/messages";
import {
  setPublicConversationHidden,
  setPublicConversationPinned,
  setPublicConversationUnread,
} from "./channels.functions";
import {
  conversationRowMenuEnabled,
  conversationRowMenuItems,
  type ConversationRowMenuItem,
} from "./conversation-row-menu-model";

/** Where a keyboard-opened menu anchors, in px from the row's left edge (the pointer's own
 * position is unavailable): just under the row's text, like the mockup's right-click menu. */
const KEYBOARD_ANCHOR_X = 32;

/** The popover's anchor point, in px relative to the row's box. */
type RowAnchor = { left: number; top: number };

function itemIcon(id: ConversationRowMenuItem["id"]) {
  if (id === "mark-unread") return MessageChatSquare;
  if (id === "pin") return Pin01;
  return XClose;
}

function itemLabel(item: ConversationRowMenuItem): string {
  if (item.id === "mark-unread") return m.conversation_menu_mark_unread();
  if (item.id === "pin")
    return item.pinned ? m.conversation_menu_unpin() : m.conversation_menu_pin();
  return m.conversation_menu_close();
}

/**
 * The list item around a channel row: right-click — or Shift+F10 / the Menu key on the focused
 * row — opens the member-level conversation menu (#122/#126). The popover anchors to an invisible
 * span placed at the pointer, never to the row's link, so navigation, focus and hover on the row
 * are untouched and a left click cannot open the menu. Close Chat is a two-step danger action
 * (`docs/design.md` §9): the menu item only opens the confirm, the confirm button is the one
 * solid red.
 */
export function ConversationRowMenu({
  channel,
  children,
}: {
  channel: { id: string; joined: boolean; pinned: boolean };
  children: ReactNode;
}) {
  const enabled = conversationRowMenuEnabled(channel);
  /** `null` = closed; otherwise the anchor point relative to this row. */
  const [anchor, setAnchor] = useState<RowAnchor | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const router = useRouter();
  const toast = useAppToast();
  const setPinned = useServerFn(setPublicConversationPinned);
  const setUnread = useServerFn(setPublicConversationUnread);
  const setHidden = useServerFn(setPublicConversationHidden);

  const items = conversationRowMenuItems(channel);

  const close = () => {
    setAnchor(null);
    setConfirming(false);
  };

  const openAt = (left: number, top: number) => {
    setConfirming(false);
    setAnchor({ left, top });
  };

  /** Runs one menu mutation, then refetches the loader so the row's order, badge and presence
   * all reflect it (the server's list owns pinned order, forced unread and the hidden filter). */
  async function run(action: () => Promise<unknown>) {
    setPending(true);
    try {
      await action();
      close();
      await router.invalidate({ sync: true });
    } catch (cause) {
      // The menu stays open with its items disabled-then-re-enabled, so the failed action is
      // retried in place; the toast only confirms that it failed (§13).
      console.error("conversation row menu action failed", cause);
      toast.error(m.conversation_menu_action_error());
    } finally {
      setPending(false);
    }
  }

  function handleAction(key: unknown) {
    if (pending) return;
    if (key === "mark-unread") {
      void run(() => setUnread({ data: { channelId: channel.id, unread: true } }));
    } else if (key === "pin") {
      void run(() => setPinned({ data: { channelId: channel.id, pinned: !channel.pinned } }));
    } else if (key === "close-chat") {
      setConfirming(true);
    }
  }

  return (
    <li
      className="relative py-px"
      onContextMenu={
        enabled
          ? (event) => {
              event.preventDefault();
              const rect = event.currentTarget.getBoundingClientRect();
              openAt(event.clientX - rect.left, event.clientY - rect.top);
            }
          : undefined
      }
      onKeyDown={
        enabled
          ? (event) => {
              if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
              event.preventDefault();
              const rect = event.currentTarget.getBoundingClientRect();
              openAt(KEYBOARD_ANCHOR_X, rect.height);
            }
          : undefined
      }
    >
      {children}
      {enabled && (
        <Dropdown.Root isOpen={anchor !== null} onOpenChange={(open) => !open && close()}>
          {/* The popover's anchor: a zero-size span at the pointer inside the row, so the row's
              own link never carries react-aria's trigger press/keyboard handling. */}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute size-0"
            style={{ left: anchor?.left ?? 0, top: anchor?.top ?? 0 }}
          />
          <Dropdown.Popover placement="bottom start">
            {confirming ? (
              <div
                role="alertdialog"
                aria-label={m.conversation_menu_close()}
                className="flex flex-col gap-3 p-3"
              >
                <p className="text-sm text-secondary">{m.conversation_menu_close_description()}</p>
                <div className="flex justify-end gap-2">
                  <Button
                    color="secondary"
                    size="sm"
                    autoFocus
                    isDisabled={pending}
                    onPress={() => setConfirming(false)}
                    className="min-w-28"
                  >
                    {m.controls_cancel()}
                  </Button>
                  <Button
                    color="primary-destructive"
                    size="sm"
                    isDisabled={pending}
                    isLoading={pending}
                    onPress={() =>
                      void run(() => setHidden({ data: { channelId: channel.id, hidden: true } }))
                    }
                    className="min-w-28"
                  >
                    {m.conversation_menu_confirm_close()}
                  </Button>
                </div>
              </div>
            ) : (
              <Dropdown.Menu aria-label={m.conversation_menu_label()} onAction={handleAction}>
                {items.map((item) => (
                  <Fragment key={item.id}>
                    {item.id === "close-chat" && <Dropdown.Separator />}
                    <Dropdown.Item
                      id={item.id}
                      icon={itemIcon(item.id)}
                      label={itemLabel(item)}
                      selectionIndicator="none"
                      isDisabled={pending}
                    />
                  </Fragment>
                ))}
              </Dropdown.Menu>
            )}
          </Dropdown.Popover>
        </Dropdown.Root>
      )}
    </li>
  );
}
