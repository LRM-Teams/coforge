import { Fragment, useState, type ReactNode } from "react";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { MessageChatSquare, Pin01, XClose } from "@untitledui/icons";

import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { useAppToast } from "#src/components/ui/toast";
import { m } from "#src/paraglide/messages";
import {
  setDirectConversationHidden,
  setDirectConversationPinned,
  setDirectConversationUnread,
} from "./conversations.functions";
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

/** What the menu acts on: a channel row (membership decides) or a direct-message row (an existing
 * conversation decides — a preference must not create one). */
export type ConversationRowMenuTarget =
  | { kind: "channel"; id: string; joined: boolean; pinned: boolean }
  | { kind: "direct"; agentId: string; enabled: boolean; pinned: boolean };

/**
 * The list item around a conversation row: the row's link is the trigger of a React Aria context
 * menu (`MenuTrigger trigger="contextMenu"`, #122/#126/#128). The framework opens it on right
 * click, long-press on touch and the platform's keyboard/screen-reader shortcuts, and places it
 * at that point; a left click stays an ordinary navigation. Close Chat acts at once, without a
 * confirm: it only hides the chat from the viewer's own list, and a new message from someone else
 * or opening the chat brings it back.
 */
export function ConversationRowMenu({
  target,
  children,
}: {
  target: ConversationRowMenuTarget;
  /** The row, whose link must be a React Aria link (`ConversationRow`): the trigger attaches to the
   * first pressable inside it. */
  children: ReactNode;
}) {
  const enabled = target.kind === "channel" ? conversationRowMenuEnabled(target) : target.enabled;
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const router = useRouter();
  const toast = useAppToast();
  const setChannelPinned = useServerFn(setPublicConversationPinned);
  const setChannelUnread = useServerFn(setPublicConversationUnread);
  const setChannelHidden = useServerFn(setPublicConversationHidden);
  const setDirectPinned = useServerFn(setDirectConversationPinned);
  const setDirectUnread = useServerFn(setDirectConversationUnread);
  const setDirectHidden = useServerFn(setDirectConversationHidden);
  // One set of calls per row kind; the two interfaces differ only in how they name the target.
  const calls =
    target.kind === "channel"
      ? {
          unread: () => setChannelUnread({ data: { channelId: target.id, unread: true } }),
          pin: () => setChannelPinned({ data: { channelId: target.id, pinned: !target.pinned } }),
          hide: () => setChannelHidden({ data: { channelId: target.id, hidden: true } }),
        }
      : {
          unread: () => setDirectUnread({ data: { agentId: target.agentId, unread: true } }),
          pin: () => setDirectPinned({ data: { agentId: target.agentId, pinned: !target.pinned } }),
          hide: () => setDirectHidden({ data: { agentId: target.agentId, hidden: true } }),
        };

  const items = conversationRowMenuItems(target);

  /** Runs one menu mutation, then refetches the loader so the row's order, badge and presence
   * all reflect it (the server's list owns pinned order, forced unread and the hidden filter). */
  async function run(action: () => Promise<unknown>) {
    setPending(true);
    try {
      await action();
      setOpen(false);
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
      void run(calls.unread);
    } else if (key === "pin") {
      void run(calls.pin);
    } else if (key === "close-chat") {
      void run(calls.hide);
    }
  }

  if (!enabled) return <li className="py-px">{children}</li>;

  return (
    // No native text selection or iOS link callout competing with the menu a long-press opens.
    <li className="py-px select-none [-webkit-touch-callout:none]">
      <Dropdown.Root trigger="contextMenu" isOpen={open} onOpenChange={setOpen}>
        {children}
        <Dropdown.Popover placement="bottom start">
          {/* Selecting an item must not close the menu: each mutation keeps it open until it
              succeeds (`run` closes it), so a failure can be retried in place. */}
          <Dropdown.Menu
            aria-label={m.conversation_menu_label()}
            onAction={handleAction}
            shouldCloseOnSelect={false}
          >
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
        </Dropdown.Popover>
      </Dropdown.Root>
    </li>
  );
}
