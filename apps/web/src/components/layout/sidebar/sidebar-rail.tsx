import type { FC, ReactNode } from "react";
import type { NavItemType } from "@/components/application/app-navigation/config";
import { cx } from "@/utils/cx";

// Adapted from Untitled's sidebar-slim.tsx (MIT; docs/ui-guidelines.md §2) —
// the demo hardcodes Untitled's own logo/account card with no override
// props. This is the app's one permanent piece of chrome, not a collapsed
// state of a wider sidebar; the 240px Channels/DMs surface is separate
// (sidebar-channels.tsx), shown only on chat routes.

export const SIDEBAR_RAIL_WIDTH = 70;

type RailItemType = NavItemType & { icon: FC<{ className?: string }>; current?: boolean };

function RailItem({ href, icon: Icon, label, current }: RailItemType) {
  return (
    <a
      href={href}
      aria-label={label}
      aria-current={current ? "page" : undefined}
      className="group flex h-14 flex-col items-center justify-center gap-1 rounded-lg px-0.5 outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-2"
    >
      <span
        className={cx(
          "flex size-10 items-center justify-center rounded-lg transition-colors duration-100 ease-linear",
          current ? "bg-sidebar-accent" : "group-hover:bg-sidebar-accent",
        )}
      >
        <Icon
          aria-hidden="true"
          className={cx(
            "size-5 transition-colors duration-100 ease-linear",
            current ? "text-brand-secondary" : "text-tertiary group-hover:text-secondary",
          )}
        />
      </span>
      <span
        className={cx(
          "text-[10px] leading-3 font-medium tracking-normal whitespace-nowrap transition-colors duration-100 ease-linear [.rail-labels-hidden_&]:hidden",
          current
            ? "font-semibold text-brand-secondary"
            : "text-tertiary group-hover:text-secondary",
        )}
      >
        {label}
      </span>
    </a>
  );
}

interface SidebarRailProps {
  activeUrl?: string;
  items: RailItemType[];
  /** Compact workspace switcher, in the top 48px band. */
  subheader?: ReactNode;
  /** Avatar + user menu at the bottom — the only Settings entry point. */
  footer: ReactNode;
}

export const SidebarRail = ({ activeUrl, items, subheader, footer }: SidebarRailProps) => {
  const rail = (
    // [data-sidebar] retints official components' bg-primary/bg-secondary/etc
    // via src/styles/coforge-theme.css.
    <aside
      data-sidebar
      style={{ width: SIDEBAR_RAIL_WIDTH }}
      className="flex h-full max-h-full flex-col items-center justify-between overflow-y-auto border-r border-secondary bg-sidebar pb-4"
    >
      <div className="flex flex-col items-center gap-3">
        <div className="flex h-12 shrink-0 items-center justify-center">{subheader}</div>
        <ul className="flex flex-col gap-1">
          {items.map((item) => (
            <li key={item.label}>
              <RailItem {...item} current={item.href === activeUrl} />
            </li>
          ))}
        </ul>
      </div>
      {footer}
    </aside>
  );

  return (
    <>
      <div className="hidden lg:fixed lg:inset-y-0 lg:left-0 lg:flex">{rail}</div>
      {/* Spacer: the real aside is `fixed`, so this reserves its width in flow. */}
      <div
        style={{ paddingLeft: SIDEBAR_RAIL_WIDTH }}
        className="invisible hidden lg:sticky lg:top-0 lg:bottom-0 lg:left-0 lg:block"
      />
    </>
  );
};
