import { useCallback, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cx } from "@/utils/cx";
import { MobileNavigationHeader } from "@/components/application/app-navigation/base-components/mobile-header";
import { NavItemBase } from "@/components/application/app-navigation/base-components/nav-item";
import { NavList } from "@/components/application/app-navigation/base-components/nav-list";
import type { NavItemType } from "@/components/application/app-navigation/config";

// Adapted from Untitled UI's application/app-navigation/sidebar-navigation/
// sidebar-simple.tsx (official, MIT) — that file is a demo template, not a
// parameterized component (it hardcodes Untitled's own logo, a search box,
// and a fake account card with no override props), so per docs/ui-guidelines.md
// §2 it's copied here and adapted rather than composed. Everything it calls
// into (base-components/**, components/base/**) stays unmodified.

export const SIDEBAR_MIN_WIDTH = 240;
export const SIDEBAR_MAX_WIDTH = 360;
export const SIDEBAR_DEFAULT_WIDTH = 280;

interface SidebarExpandedProps {
  /** URL of the currently active item. */
  activeUrl?: string;
  /** List of items to display. */
  items: NavItemType[];
  /** List of footer items to display. */
  footerItems?: NavItemType[];
  /** Workspace switcher + user menu + collapse control. */
  footer: ReactNode;
  /** Control rendered at the right end of the logo row (the collapse button). */
  headerAction?: ReactNode;
  /** Current width in pixels (controlled). */
  width: number;
  /** Called while the user drags the resize handle, with the next clamped width. */
  onWidthChange: (width: number) => void;
}

export const SidebarExpanded = ({
  activeUrl,
  items,
  footerItems = [],
  headerAction,
  footer,
  width,
  onWidthChange,
}: SidebarExpandedProps) => {
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

  const content = (
    // data-sidebar retints the official NavItemBase's bg-primary/bg-secondary/
    // text-secondary/text-fg-quaternary utilities via the [data-sidebar] rule
    // in src/styles/coforge-theme.css, rather than editing that base-component
    // file. See the comment there for why this has to target the
    // second-namespace `--background-color-*`/`--text-color-*` variables and
    // not `--color-bg-*` directly.
    <aside
      data-sidebar
      style={{ "--width": `${width}px` } as CSSProperties}
      className="relative flex h-full w-full max-w-full flex-col justify-between overflow-auto bg-sidebar pt-4 lg:w-(--width) lg:border-r lg:border-secondary lg:pt-5"
    >
      <div className="flex items-center gap-2 px-4 lg:px-5">
        <img src="/logo.svg" alt="" className="size-6 shrink-0" />
        <span className="text-sm font-semibold text-primary">CoForge</span>
        {headerAction && <div className="ml-auto">{headerAction}</div>}
      </div>

      <NavList activeUrl={activeUrl} items={items} className="mt-5" />

      <div className="mt-auto flex flex-col gap-3 px-4 py-4 lg:py-5">
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
  );

  return (
    <>
      {/* Mobile header navigation (official, unmodified — still shows
          Untitled's own logo; MobileNavigationHeader wasn't part of the
          copy-and-adapt exception, only sidebar-simple/slim were). */}
      <MobileNavigationHeader>{content}</MobileNavigationHeader>

      {/* Desktop sidebar navigation. The resize handle is a sibling of the
          `aside`, not a child of it — the aside is `overflow-auto` (it
          scrolls its own nav list), which clips any absolutely-positioned
          descendant that pokes outside its box, including the handle
          (found via elementsFromPoint while verifying the drag interaction:
          the handle was in the accessibility tree and had a real bounding
          rect, but never received the hit — the aside's own scroll clip
          silently ate it). Living outside the scroll container keeps it
          hit-testable across the full sidebar height. */}
      <div
        style={{ "--width": `${width}px` } as CSSProperties}
        className="hidden lg:fixed lg:inset-y-0 lg:left-0 lg:flex lg:w-(--width)"
      >
        {content}

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
