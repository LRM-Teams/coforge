import { useCallback, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { LayoutLeft as PanelLeft } from "@untitledui/icons";
import { cx } from "@/utils/cx";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { MobileNavigationHeader } from "@/components/layout/sidebar/mobile-header";
import { SIDEBAR_RAIL_WIDTH } from "@/components/layout/sidebar/sidebar-rail";
import {
  SidebarConversations,
  type SidebarChannel,
} from "@/components/layout/sidebar/sidebar-conversations";
import { NavList } from "@/components/application/app-navigation/base-components/nav-list";
import type { NavItemType } from "@/components/application/app-navigation/config";
import type { ConversationAgent } from "@/features/conversations/conversation-layout";
import { m } from "@/paraglide/messages";

// Adapted from Untitled's sidebar-simple.tsx (MIT; docs/ui-guidelines.md §2).
// Two surfaces: `ChannelSidebar` (desktop, chat routes only, no top-level nav
// — that's in the rail) and `SidebarMobileDrawer` (everything, below `lg`).

export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 320;
export const SIDEBAR_DEFAULT_WIDTH = 240;

interface ConversationSectionsProps {
  channels: SidebarChannel[];
  agents: ConversationAgent[];
  selectedChannelId?: string;
  selectedAgentId?: string;
  onCreateChannel?: () => void;
}

interface ChannelSidebarProps extends ConversationSectionsProps {
  /** Current workspace's display name, shown in the header row. */
  workspaceName?: string;
  /** Hides the channel sidebar (the conversation header then shows a "show
   * channels" control — see AppShell's ChannelSidebarContext). */
  onHide: () => void;
  /** Current width in pixels (controlled). */
  width: number;
  /** Called while the user drags the resize handle, with the next clamped width. */
  onWidthChange: (width: number) => void;
}

/** Channels/Direct-messages panel next to the rail; header carries the
 * Workspace name (switching lives in the rail's compact switcher) + hide. */
export const ChannelSidebar = ({
  workspaceName,
  onHide,
  width,
  onWidthChange,
  ...conversations
}: ChannelSidebarProps) => {
  const [dragging, setDragging] = useState(false);
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);

  const onHandlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      dragState.current = { startX: event.clientX, startWidth: width };
      setDragging(true);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [width],
  );
  const onHandlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragState.current) return;
      const next = dragState.current.startWidth + (event.clientX - dragState.current.startX);
      onWidthChange(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, next)));
    },
    [onWidthChange],
  );
  const onHandlePointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    dragState.current = null;
    setDragging(false);
    event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  return (
    <>
      {/* The handle lives outside the `aside` — it's `overflow-auto` and
          would clip an absolutely-positioned child that pokes past its box. */}
      <div
        style={{ "--width": `${width}px`, left: SIDEBAR_RAIL_WIDTH } as CSSProperties}
        className="hidden lg:fixed lg:inset-y-0 lg:flex lg:w-(--width)"
      >
        {/* [data-sidebar] retints official components via src/styles/coforge-theme.css. */}
        <aside
          data-sidebar
          style={{ "--width": `${width}px` } as CSSProperties}
          className="relative flex h-full w-full max-w-full flex-col bg-sidebar lg:w-(--width) lg:border-r lg:border-secondary"
        >
          <div className="flex h-12 shrink-0 items-center gap-2 px-4 lg:px-5">
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-primary">
              {workspaceName}
            </span>
            <ButtonUtility
              icon={PanelLeft}
              size="sm"
              color="tertiary"
              tooltip={m.controls_hide_sidebar()}
              onClick={onHide}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <SidebarConversations {...conversations} />
          </div>
        </aside>

        {/* Invisible 8px hit area on the hairline; a 2px brand line shows on hover/drag. */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          className={cx(
            "absolute inset-y-0 -right-1 w-2 cursor-col-resize touch-none",
            "after:absolute after:inset-y-0 after:right-1 after:w-0.5 after:bg-transparent hover:after:bg-brand-solid",
            dragging && "after:bg-brand-solid",
          )}
          onPointerDown={onHandlePointerDown}
          onPointerMove={onHandlePointerMove}
          onPointerUp={onHandlePointerUp}
        />
      </div>

      {/* Spacer following the live (resized) width — the real sidebar is `fixed`. */}
      <div
        style={{ paddingLeft: width }}
        className="invisible hidden lg:sticky lg:top-0 lg:bottom-0 lg:left-0 lg:block"
      />
    </>
  );
};

interface SidebarMobileDrawerProps extends ConversationSectionsProps {
  activeUrl?: string;
  items: NavItemType[];
  subheader?: ReactNode;
  /** Avatar + user menu — the only Settings entry point. */
  footer: ReactNode;
}

/** The full mobile drawer — below `lg` there's no rail, so this carries
 * everything regardless of route. */
export const SidebarMobileDrawer = ({
  activeUrl,
  items,
  subheader,
  footer,
  ...conversations
}: SidebarMobileDrawerProps) => (
  <MobileNavigationHeader>
    <aside data-sidebar className="flex h-full w-full max-w-full flex-col bg-sidebar">
      <div className="flex h-12 shrink-0 items-center gap-2 px-4 lg:px-5">
        <img src="/logo.svg" alt="" className="size-6 shrink-0" />
        <span className="text-sm font-semibold text-primary">CoForge</span>
      </div>
      {subheader && <div className="shrink-0 px-4 pt-1 lg:px-5">{subheader}</div>}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* NavList's own pt-5 (official, unmodified) overshoots the 8px gap
            the workspace row needs below it; -mt-3 pulls it back. */}
        <NavList activeUrl={activeUrl} items={items} className="-mt-3" />
        <SidebarConversations {...conversations} />
      </div>

      <div className="mt-auto shrink-0 px-4 py-4 lg:py-5">{footer}</div>
    </aside>
  </MobileNavigationHeader>
);
