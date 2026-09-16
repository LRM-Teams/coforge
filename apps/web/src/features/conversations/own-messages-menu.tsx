import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { List } from "@untitledui/icons";
import { MenuItem as AriaMenuItem, Popover as AriaPopover } from "react-aria-components";

import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Dropdown } from "@/components/base/dropdown/dropdown";
import { LoadingIndicator } from "@/components/ui/loading-indicator";
import { RelativeTime } from "@/components/ui/relative-time";
import { useAppToast } from "@/components/ui/toast";
import { useStateWithRef } from "@/hooks/use-state-with-ref";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";
import { mergeMessages } from "./conversation-messages";

export type OwnMessageIndexEntry = {
  id: string;
  sequence: number;
  body: string;
  createdAt: Date | string;
  attachmentFileName?: string;
};

/**
 * The current user's own messages as a separately paged index, for jumping back to one.
 * Without a loader the index is the own messages already loaded in the conversation.
 */
export function useOwnMessagesIndex({
  conversationId,
  enabled,
  onLoad,
  fallback,
}: {
  conversationId: string;
  /** Thread panes have no index of their own. */
  enabled: boolean;
  onLoad?: (beforeSequence?: number) => Promise<{
    messages: OwnMessageIndexEntry[];
    hasOlder: boolean;
  }>;
  fallback: OwnMessageIndexEntry[];
}) {
  const toast = useAppToast();
  const [index, setIndex] = useState<OwnMessageIndexEntry[]>([]);
  const [hasOlder, setHasOlder] = useState(false);
  const [loading, loadingRef, setLoading] = useStateWithRef(false);
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const scrollAnchorRef = useRef<{ height: number; top: number } | undefined>(undefined);
  const scrollToLatestRef = useRef(false);
  const messages = onLoad ? index : fallback;

  async function load(beforeSequence?: number, reportError = true) {
    if (!onLoad || loadingRef.current) return;
    if (beforeSequence !== undefined && !hasOlder) return;
    const menu = menuRef.current;
    if (beforeSequence !== undefined && menu) {
      scrollAnchorRef.current = { height: menu.scrollHeight, top: menu.scrollTop };
    } else {
      scrollToLatestRef.current = true;
    }
    setLoading(true);
    try {
      const page = await onLoad(beforeSequence);
      setHasOlder(page.hasOlder);
      setIndex((current) => mergeMessages(current, page.messages));
    } catch (cause) {
      scrollAnchorRef.current = undefined;
      scrollToLatestRef.current = false;
      if (reportError) toast.error(m.conversation_history_load_error(), cause);
    } finally {
      setLoading(false);
    }
  }

  // Keep the menu's scroll position across a prepended page, or pin it to the newest entry.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const anchor = scrollAnchorRef.current;
    if (anchor) {
      menu.scrollTop = anchor.top + menu.scrollHeight - anchor.height;
      scrollAnchorRef.current = undefined;
    } else if (scrollToLatestRef.current) {
      menu.scrollTop = menu.scrollHeight;
      scrollToLatestRef.current = false;
    }
  }, [messages[0]?.sequence, messages.at(-1)?.sequence]);

  useEffect(() => {
    setIndex([]);
    setHasOlder(false);
    setLoading(false);
    setOpen(false);
    scrollAnchorRef.current = undefined;
    if (enabled && onLoad) void load(undefined, false);
  }, [conversationId]);

  return {
    messages,
    loading,
    open,
    setOpen,
    menuRef,
    loadOlder: () => void load(messages[0]?.sequence),
    /** Record a message of the user's the server just accepted. */
    add(message: OwnMessageIndexEntry) {
      if (!onLoad) return;
      setIndex((current) => mergeMessages(current, [message]));
      scrollToLatestRef.current = true;
    },
  };
}

export function OwnMessagesMenu({
  messages,
  loading,
  open,
  onOpenChange,
  menuRef,
  onLoadOlder,
  onSelect,
}: {
  messages: OwnMessageIndexEntry[];
  loading: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  menuRef: RefObject<HTMLDivElement | null>;
  onLoadOlder: () => void;
  onSelect: (messageId: string) => void;
}) {
  return (
    <Dropdown.Root
      isOpen={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) return;
        requestAnimationFrame(() => {
          const menu = menuRef.current;
          if (menu) menu.scrollTop = menu.scrollHeight;
        });
      }}
    >
      <ButtonUtility
        icon={List}
        size="xs"
        color="tertiary"
        className="rounded-full"
        aria-label={m.conversation_your_messages()}
      />
      {/*
        Dropdown.Popover isn't typed to accept a ref (the vendored wrapper
        doesn't forward one), and this menu needs to read/set scrollTop for
        infinite-loading-older-messages + scroll-to-latest-on-open. Render
        the underlying react-aria-components Popover directly instead,
        mirroring Dropdown.Popover's own default classes.
      */}
      <AriaPopover
        ref={menuRef}
        placement="top start"
        offset={8}
        crossOffset={-4}
        // React Aria sizes the popover to the viewport with an inline max-height,
        // which would override the class below; cap it here instead. Ten rows.
        maxHeight={400}
        className={(state) =>
          cn(
            "origin-(--trigger-anchor-point) overflow-auto rounded-lg bg-primary shadow-lg ring-1 ring-secondary_alt will-change-transform",
            state.isEntering &&
              "duration-150 ease-out animate-in fade-in placement-right:slide-in-from-left-0.5 placement-top:slide-in-from-bottom-0.5 placement-bottom:slide-in-from-top-0.5",
            state.isExiting &&
              "duration-100 ease-in animate-out fade-out placement-right:slide-out-to-left-0.5 placement-top:slide-out-to-bottom-0.5 placement-bottom:slide-out-to-top-0.5",
            "max-h-[400px] w-[min(24rem,calc(100vw-2.5rem))] p-1.5 [scrollbar-width:thin]",
          )
        }
        onScroll={(event) => {
          if (event.currentTarget.scrollTop <= 16) onLoadOlder();
        }}
      >
        {loading && (
          <div
            // The live region stays, so its appearance is announced; the spinner inside it
            // carries the name, rather than labelling the same thing twice.
            role="status"
            className={cn(
              "flex items-center justify-center text-tertiary",
              messages.length ? "sticky top-0 z-10 h-7 rounded-md bg-primary" : "h-14",
            )}
          >
            <LoadingIndicator className="size-4" label={m.conversation_loading_your_messages()} />
          </div>
        )}
        <Dropdown.Menu
          aria-label={m.conversation_your_messages()}
          onAction={(key) => onSelect(String(key))}
        >
          {messages.map((message) => (
            <AriaMenuItem
              key={message.id}
              id={message.id}
              textValue={message.body || message.attachmentFileName}
              className="group block cursor-pointer px-1.5 py-px outline-hidden"
            >
              {(state) => (
                <div
                  className={cn(
                    "flex min-h-9 items-center gap-3 rounded-md px-2.5 py-1.5 outline-focus-ring transition duration-100 ease-linear",
                    "group-hover:bg-primary_hover",
                    state.isFocused && "bg-primary_hover",
                    state.isFocusVisible && "outline-2 -outline-offset-2",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate font-medium text-secondary">
                    {message.body || message.attachmentFileName}
                  </span>
                  <RelativeTime
                    value={message.createdAt}
                    className="shrink-0 text-xs whitespace-nowrap text-tertiary"
                  />
                </div>
              )}
            </AriaMenuItem>
          ))}
        </Dropdown.Menu>
      </AriaPopover>
    </Dropdown.Root>
  );
}
