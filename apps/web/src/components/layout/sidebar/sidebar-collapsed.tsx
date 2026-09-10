import type { FC, ReactNode } from "react";
import { LayoutLeft as PanelLeft } from "@untitledui/icons";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { MobileNavigationHeader } from "@/components/layout/sidebar/mobile-header";
import { NavButton } from "@/components/application/app-navigation/base-components/nav-button";
import { NavList } from "@/components/application/app-navigation/base-components/nav-list";
import type { NavItemType } from "@/components/application/app-navigation/config";

// Adapted from Untitled UI's application/app-navigation/sidebar-navigation/
// sidebar-slim.tsx (official, MIT) — a demo template, not a parameterized
// component (hardcoded Untitled logo, a fake "Olivia Rhye" account card and
// menu with no override props, and a hover-flyout secondary sidebar for
// sub-items CoForge doesn't have), so per docs/ui-guidelines.md §2 it's
// copied here and adapted. Everything it calls into (base-components/**,
// components/base/**) stays unmodified.

export const SIDEBAR_RAIL_WIDTH = 68;

interface SidebarCollapsedProps {
  /** URL of the currently active item. */
  activeUrl?: string;
  /** List of items to display. */
  items: (NavItemType & { icon: FC<{ className?: string }> })[];
  /** List of footer items to display. */
  footerItems?: (NavItemType & { icon: FC<{ className?: string }> })[];
  /** Real avatar + user menu, rendered at the bottom of the rail. */
  footer: ReactNode;
  /** Expands the sidebar back out. */
  onExpand: () => void;
}

export const SidebarCollapsed = ({
  activeUrl,
  items,
  footerItems = [],
  footer,
  onExpand,
}: SidebarCollapsedProps) => {
  const mainSidebar = (
    // data-sidebar retints NavButton's bg-primary/bg-secondary/text-secondary_hover/
    // text-fg-quaternary utilities via the [data-sidebar] rule in
    // src/styles/coforge-theme.css — see sidebar-expanded.tsx and that file's
    // comment for why this can't be an inline `--color-bg-*` override.
    <aside
      data-sidebar
      style={{ width: SIDEBAR_RAIL_WIDTH }}
      className="flex h-full max-h-full flex-col justify-between overflow-y-auto border-r border-secondary bg-sidebar py-4"
    >
      <div className="flex flex-col items-center gap-3">
        <ButtonUtility
          icon={PanelLeft}
          size="sm"
          color="tertiary"
          tooltip="Expand sidebar"
          onClick={onExpand}
        />
        <ul className="flex flex-col gap-0.5">
          {items.map((item) => (
            <li key={item.label}>
              <NavButton
                current={item.href === activeUrl}
                href={item.href}
                label={item.label || ""}
                icon={item.icon}
              />
            </li>
          ))}
        </ul>
      </div>
      <div className="flex flex-col items-center gap-3">
        {footerItems.length > 0 && (
          <ul className="flex flex-col gap-0.5">
            {footerItems.map((item) => (
              <li key={item.label}>
                <NavButton
                  current={item.href === activeUrl}
                  label={item.label || ""}
                  href={item.href}
                  icon={item.icon}
                />
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
      {/* Desktop sidebar navigation */}
      <div className="hidden lg:fixed lg:inset-y-0 lg:left-0 lg:flex">{mainSidebar}</div>

      {/* Placeholder to take up physical space because the real sidebar has
          `fixed` position. */}
      <div
        style={{ paddingLeft: SIDEBAR_RAIL_WIDTH }}
        className="invisible hidden lg:sticky lg:top-0 lg:bottom-0 lg:left-0 lg:block"
      />

      {/* Mobile header navigation (official, unmodified — still shows
          Untitled's own logo). On mobile there's no separate "collapsed"
          state, so this shows the same full nav as the expanded sidebar. */}
      <MobileNavigationHeader>
        <aside
          data-sidebar
          className="flex h-full max-h-full w-full max-w-full flex-col justify-between overflow-y-auto bg-sidebar pt-4"
        >
          <div className="flex items-center gap-2 px-4">
            <img src="/logo.svg" alt="" className="size-6 shrink-0" />
            <span className="text-sm font-semibold text-primary">CoForge</span>
          </div>
          <NavList activeUrl={activeUrl} items={items} className="mt-5" />
          <div className="mt-auto flex flex-col gap-3 p-4">{footer}</div>
        </aside>
      </MobileNavigationHeader>
    </>
  );
};
