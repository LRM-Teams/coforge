import type { ReactNode } from "react";
import { MobileNavigationHeader } from "#src/components/layout/sidebar/mobile-header";
import { NavList } from "#src/components/application/app-navigation/base-components/nav-list";
import type { NavItemType } from "#src/components/application/app-navigation/config";

interface SidebarMobileDrawerProps {
  activeUrl?: string;
  items: NavItemType[];
  subheader?: ReactNode;
  footer: ReactNode;
}

/** Global destinations only; the Chat page owns conversation selection. */
export const SidebarMobileDrawer = ({
  activeUrl,
  items,
  subheader,
  footer,
}: SidebarMobileDrawerProps) => (
  <MobileNavigationHeader>
    <aside data-sidebar className="flex h-full w-full max-w-full flex-col bg-sidebar">
      <div className="flex h-12 shrink-0 items-center gap-2 px-4 lg:px-5">
        <img src="/logo.svg" alt="" className="size-6 shrink-0" />
        <span className="text-sm font-semibold text-primary">CoForge</span>
      </div>
      {subheader && <div className="shrink-0 px-4 pt-1 lg:px-5">{subheader}</div>}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <NavList activeUrl={activeUrl} items={items} className="-mt-3" />
      </div>
      <div className="mt-auto shrink-0 px-4 py-4 lg:py-5">{footer}</div>
    </aside>
  </MobileNavigationHeader>
);
