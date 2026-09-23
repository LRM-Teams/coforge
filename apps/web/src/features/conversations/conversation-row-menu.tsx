import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { MessageChatSquare, Pin01, XClose } from "@untitledui/icons";

import { Button } from "@/components/base/buttons/button";
import { Dropdown } from "@/components/base/dropdown/dropdown";
import { useAppToast } from "@/components/ui/toast";
import { m } from "@/paraglide/messages";
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
  LONG_PRESS_MS,
  longPressAnchorPoint,
  movedBeyondSlop,
  rowClickSuppressed,
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
 * (`docs/design/field-display.md` §9): the menu item only opens the confirm, the confirm button is the one
 * solid red.
 */
/** What the menu acts on: a channel row (membership decides) or a direct-message row (an existing
 * conversation decides — a preference must not create one). */
export type ConversationRowMenuTarget =
  | { kind: "channel"; id: string; joined: boolean; pinned: boolean }
  | { kind: "direct"; agentId: string; enabled: boolean; pinned: boolean };

export function ConversationRowMenu({
  target,
  children,
}: {
  target: ConversationRowMenuTarget;
  children: ReactNode;
}) {
  const enabled = target.kind === "channel" ? conversationRowMenuEnabled(target) : target.enabled;
  /** `null` = closed; otherwise the anchor point relative to this row. */
  const [anchor, setAnchor] = useState<RowAnchor | null>(null);
  const [confirming, setConfirming] = useState(false);
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

  const close = () => {
    setAnchor(null);
    setConfirming(false);
  };

  const openAt = (left: number, top: number) => {
    setConfirming(false);
    setAnchor({ left, top });
  };

  /** The touch that might become a long-press (#128): where it started and its pending timer. */
  const pressStart = useRef<{ x: number; y: number } | null>(null);
  /** The zero-size span at the pointer the popover positions against (see the JSX below). */
  const anchorRef = useRef<HTMLSpanElement>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelLongPress = () => {
    if (pressTimer.current !== null) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
    pressStart.current = null;
  };

  // A row can unmount mid-hold (another pane's invalidate refetches the list): don't leak the timer.
  useEffect(() => cancelLongPress, []);

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
      void run(calls.unread);
    } else if (key === "pin") {
      void run(calls.pin);
    } else if (key === "close-chat") {
      setConfirming(true);
    }
  }

  return (
    <li
      className={
        // Long-press rows (#128): no native text selection or iOS link callout competing with
        // the menu the hold opens.
        enabled ? "relative py-px select-none [-webkit-touch-callout:none]" : "relative py-px"
      }
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
      onTouchStart={
        enabled
          ? (event) => {
              const touch = event.touches[0];
              if (!touch) return;
              const rect = event.currentTarget.getBoundingClientRect();
              const start = { x: touch.clientX, y: touch.clientY };
              pressStart.current = start;
              pressTimer.current = setTimeout(() => {
                pressTimer.current = null;
                pressStart.current = null;
                // The anchor comes from where the finger went down; drift past the slop
                // (touchmove) would have cancelled this timer as a scroll.
                const point = longPressAnchorPoint(start.x, start.y, rect);
                openAt(point.left, point.top);
              }, LONG_PRESS_MS);
            }
          : undefined
      }
      onTouchMove={
        enabled
          ? (event) => {
              if (pressTimer.current === null || !pressStart.current) return;
              const touch = event.touches[0];
              if (
                !touch ||
                movedBeyondSlop(pressStart.current, { x: touch.clientX, y: touch.clientY })
              ) {
                cancelLongPress();
              }
            }
          : undefined
      }
      onTouchEnd={enabled ? cancelLongPress : undefined}
      onTouchCancel={enabled ? cancelLongPress : undefined}
      onClickCapture={
        enabled
          ? (event) => {
              // With the menu open the arriving click is the long-press's own release (or a tap
              // on the row under the menu): swallow it so the row doesn't navigate under it.
              if (!rowClickSuppressed(anchor !== null)) return;
              event.preventDefault();
              event.stopPropagation();
              close();
            }
          : undefined
      }
    >
      {children}
      {enabled && (
        <Dropdown.Root isOpen={anchor !== null} onOpenChange={(open) => !open && close()}>
          {/* The popover's anchor: a zero-size span at the pointer inside the row, so the row's
              own link never carries react-aria's trigger press/keyboard handling. MenuTrigger only
              learns its trigger's ref from a pressable child, so the span is handed to the popover
              as `triggerRef` — without it the popover has nothing to position against and opens
              at the viewport's top-left corner. */}
          <span
            ref={anchorRef}
            aria-hidden="true"
            className="pointer-events-none absolute size-0"
            style={{ left: anchor?.left ?? 0, top: anchor?.top ?? 0 }}
          />
          <Dropdown.Popover triggerRef={anchorRef} placement="bottom start">
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
                    onPress={() => void run(calls.hide)}
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
