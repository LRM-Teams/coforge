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
import { NavItemBase } from "@/components/application/app-navigation/base-components/nav-item";
import { NavList } from "@/components/application/app-navigation/base-components/nav-list";
import type { NavItemType } from "@/components/application/app-navigation/config";
import type { ConversationAgent } from "@/features/conversations/conversation-layout";
import { m } from "@/paraglide/messages";

// Adapted from Untitled UI's application/app-navigation/sidebar-navigation/
// sidebar-simple.tsx (official, MIT) — that file is a demo template, not a
// parameterized component (it hardcodes Untitled's own logo, a search box,
// and a fake account card with no override props), so per docs/ui-guidelines.md
// §2 it's copied here and adapted. Everything it calls into (base-components/**,
// components/base/**) stays unmodified.
//
// This file now covers two different surfaces that used to share one
// "expanded sidebar" component:
//  - `ChannelSidebar`: the desktop-only, resizable Channels/Direct-messages
//    panel, shown only on chat routes next to the permanent icon rail
//    (sidebar-rail.tsx). It carries no top-level nav — that lives in the rail.
//  - `SidebarMobileDrawer`: the full mobile drawer (nav items, workspace
//    switcher, Channels/Direct messages, footer) shown below the `lg`
//    breakpoint regardless of route, since there's no separate rail on mobile.

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

/**
 * The Channels/Direct-messages panel, shown only on `/messages/**` routes
 * next to the permanent icon rail. Its header row carries the current
 * Workspace's name (the rail's compact WorkspaceSwitcher is the place to
 * change Workspaces) and a control to hide the panel.
 */
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
      {/* The resize handle is a sibling of the `aside`, not a child of it —
          the aside is `overflow-auto` (it scrolls its own conversation
          lists), which clips any absolutely-positioned descendant that
          pokes outside its box, including the handle. Living outside the
          scroll container keeps it hit-testable across the full height. */}
      <div
        style={{ "--width": `${width}px`, left: SIDEBAR_RAIL_WIDTH } as CSSProperties}
        className="hidden lg:fixed lg:inset-y-0 lg:flex lg:w-(--width)"
      >
        {/* data-sidebar retints the official NavItemBase's bg-primary/bg-secondary/
            text-secondary/text-fg-quaternary utilities via the [data-sidebar] rule
            in src/styles/coforge-theme.css, rather than editing that base-component
            file. See the comment there for why this has to target the
            second-namespace `--background-color-*`/`--text-color-*` variables and
            not `--color-bg-*` directly. */}
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

        {/* Invisible resize handle: 8px hit area centered on the hairline,
            shows a 2px brand line on hover/drag. */}
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

      {/* Placeholder to take up physical space because the real sidebar has
          `fixed` position — follows the live (resized) width. */}
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
  footerItems?: NavItemType[];
  subheader?: ReactNode;
  footer: ReactNode;
}

/**
 * The full mobile drawer: below `lg` there's no separate rail, so this shows
 * everything — nav items, workspace switcher, Channels, Direct messages, and
 * the user's footer card — regardless of which route is open.
 */
export const SidebarMobileDrawer = ({
  activeUrl,
  items,
  footerItems = [],
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
        <NavList activeUrl={activeUrl} items={items} className="mt-3" />
        <SidebarConversations {...conversations} />
      </div>

      <div className="mt-auto flex shrink-0 flex-col gap-3 px-4 py-4 lg:py-5">
        {footerItems.length > 0 && (
          <ul className="flex flex-col">
            {footerItems.map((item) => (
              <li key={item.label} className="py-px">
                <NavItemBase
                  badge={item.badge}
                  icon={item.icon}
                  href={item.href}
                  type="link"
                  current={item.href === activeUrl}
                >
                  {item.label}
                </NavItemBase>
              </li>
            ))}
          </ul>
        )}

        {footer}
      </div>
    </aside>
  </MobileNavigationHeader>
);
