import { useCallback, useState, type FC } from "react";
import { useHotkey } from "@tanstack/react-hotkeys";
import { useRouter, useRouterState } from "@tanstack/react-router";
import {
  ChevronSelectorVertical,
  CheckSquare as ListTodo,
  LayoutLeft as PanelLeft,
  LogOut01 as LogOut,
  MessageCircle01 as MessageCircle,
  Monitor01 as Monitor,
  Settings01,
  Users01 as Users,
} from "@untitledui/icons";
import { Button as AriaButton } from "react-aria-components";

import type { NavItemType } from "@/components/application/app-navigation/config";
import { SidebarNavigationSimple } from "@/components/application/app-navigation/sidebar-navigation/sidebar-simple";
import { SidebarNavigationSlim } from "@/components/application/app-navigation/sidebar-navigation/sidebar-slim";
import { Avatar } from "@/components/base/avatar/avatar";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Dropdown } from "@/components/base/dropdown/dropdown";
import { WorkspaceSwitcher, type WorkspaceOption } from "@/features/workspaces/workspace-switcher";
import { avatarInitial, avatarToneClassName } from "@/lib/avatar-tone";
import { cx } from "@/utils/cx";
import { m } from "@/paraglide/messages";
import { localizeHref } from "@/paraglide/runtime";

const sidebarShortcut = "Mod+B" as const;

export type AppUser = {
  name: string;
  email: string;
  avatarUrl?: string | null;
};

function useNavItems(): (NavItemType & { icon: FC<{ className?: string }>; bareHref: string })[] {
  return [
    {
      label: m.navigation_agents(),
      bareHref: "/agents",
      href: localizeHref("/agents"),
      icon: Users,
    },
    {
      label: m.navigation_messages(),
      bareHref: "/messages",
      href: localizeHref("/messages"),
      icon: MessageCircle,
    },
    { label: m.tasks_tab(), bareHref: "/tasks", href: localizeHref("/tasks"), icon: ListTodo },
    {
      label: m.navigation_computers(),
      bareHref: "/computers",
      href: localizeHref("/computers"),
      icon: Monitor,
    },
  ];
}

/**
 * Untitled's NavItemBase/NavButton (official, unmodified) render plain
 * `<a href>` tags with no per-item onClick hook, so clicking them would
 * trigger a full browser navigation instead of a TanStack Router
 * client-side transition. This intercepts same-origin, unmodified left
 * clicks on any link inside the sidebar and routes them through the
 * router instead, leaving modifier-clicks (open in new tab, etc.) to the
 * browser's native handling.
 */
function useSpaNavigation() {
  const router = useRouter();
  return useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      const anchor = (event.target as HTMLElement).closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target && anchor.target !== "_self") return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      event.preventDefault();
      void router.navigate({ href: url.pathname + url.search + url.hash });
    },
    [router],
  );
}

export function AppShell({
  user,
  workspaces = [],
  currentWorkspace = null,
  onSelectWorkspace,
  onCreateWorkspace,
  onSignOut,
  children,
}: {
  user: AppUser;
  workspaces?: WorkspaceOption[];
  currentWorkspace?: WorkspaceOption | null;
  onSelectWorkspace?: (slug: string) => Promise<void> | void;
  onCreateWorkspace?: (input: { name: string; slug: string }) => Promise<void>;
  onSignOut?: () => Promise<void> | void;
  children: React.ReactNode;
}) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // The router's own `location.pathname` is de-localized (see the `rewrite.input`
  // hook in src/router.tsx, which strips the locale prefix for internal route
  // matching) while each nav item's `href` is the localized, user-facing string
  // (see `bareHref` below). Match against the de-localized pathname, but hand
  // NavList back the item's own (localized) href — NavItemBase/NavList (official,
  // unmodified) mark an item current via a plain `item.href === activeUrl` string
  // equality, with no prefix matching for sub-routes (e.g. /messages/agent-1
  // under the Messages item), so resolve the matching item ourselves.
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const navItems = useNavItems();
  const activeUrl = navItems.find(
    (item) => pathname === item.bareHref || pathname.startsWith(`${item.bareHref}/`),
  )?.href;
  const onSidebarClickCapture = useSpaNavigation();

  useHotkey(sidebarShortcut, () => setSidebarCollapsed((collapsed) => !collapsed));

  const featureCard = (
    <div className="flex flex-col gap-3">
      <WorkspaceSwitcher
        workspaces={workspaces}
        current={currentWorkspace}
        onSelect={onSelectWorkspace}
        onCreate={onCreateWorkspace}
      />
      <UserMenuCard user={user} onSignOut={onSignOut} />
      <ButtonUtility
        icon={PanelLeft}
        size="sm"
        color="tertiary"
        tooltip={m.controls_hide_sidebar()}
        onClick={() => setSidebarCollapsed(true)}
      />
    </div>
  );

  return (
    <div className="min-h-svh bg-primary font-body antialiased lg:flex">
      {/*
        SidebarNavigationSimple/Slim render their real sidebar `position: fixed`
        and rely on an invisible sibling "spacer" div (padding-left equal to the
        sidebar's width) to reserve room for it in normal flow — but that only
        works when the spacer's parent is a flex row, which is why this shell is
        `lg:flex` rather than plain block. The `contents` wrapper keeps the
        sidebar's own fragment (mobile header + fixed sidebar + spacer) as direct
        flex items here instead of being boxed inside an extra div.
      */}
      <div onClickCapture={onSidebarClickCapture} className="contents">
        {sidebarCollapsed ? (
          // Untitled's official SidebarNavigationSlim (unmodified) always renders its own
          // built-in account switcher at the bottom with hardcoded placeholder data
          // ("Olivia Rhye") and no prop to disable, override, or wire it to real sign-out —
          // a known limitation of the official free component, not something CoForge adds.
          // Real account access (including sign-out) stays reachable by expanding the
          // sidebar back to SidebarNavigationSimple, which uses a real, working user menu
          // (see UserMenuCard below) instead of the official demo widget. There is also no
          // prop to expand the rail back out from inside Slim itself, so the expand control
          // lives in the main content area (see the ButtonUtility rendered just after this
          // sidebar block).
          <SidebarNavigationSlim
            activeUrl={activeUrl}
            items={navItems}
            footerItems={[
              {
                label: m.navigation_personal_settings(),
                href: localizeHref("/settings"),
                icon: Settings01,
              },
            ]}
          />
        ) : (
          <SidebarNavigationSimple
            activeUrl={activeUrl}
            items={navItems}
            showAccountCard={false}
            featureCard={featureCard}
            className={cx(
              "bg-sidebar",
              // CoForge lavender tint: Untitled's own sidebar is plain `bg-primary`, so this
              // scopes `--color-bg-primary` (read by every `bg-primary` utility inside, e.g.
              // the search input and nav items' resting state) to the sidebar tint instead of
              // touching sidebar-simple.tsx itself.
              "[--color-bg-primary:var(--color-sidebar)]",
            )}
          />
        )}
      </div>

      {sidebarCollapsed && (
        <div className="fixed top-3 left-[calc(68px+0.5rem)] z-40 hidden lg:block">
          <ButtonUtility
            icon={PanelLeft}
            size="sm"
            color="secondary"
            tooltip={m.controls_show_sidebar()}
            onClick={() => setSidebarCollapsed(false)}
          />
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

function UserMenuCard({
  user,
  onSignOut,
}: {
  user: AppUser;
  onSignOut?: () => Promise<void> | void;
}) {
  return (
    <Dropdown.Root>
      <AriaButton
        aria-label={m.controls_current_user()}
        className="relative flex w-full items-center gap-3 rounded-xl p-3 text-left outline-focus-ring ring-1 ring-secondary transition duration-100 ease-linear ring-inset hover:bg-primary_hover focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        <Avatar
          size="md"
          src={user.avatarUrl}
          alt={user.name}
          initials={avatarInitial(user.name)}
          contentClassName={avatarToneClassName(user.name)}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-primary">{user.name}</span>
          <span className="block truncate text-sm text-tertiary">{user.email}</span>
        </span>
        <ChevronSelectorVertical
          aria-hidden="true"
          className="size-4 shrink-0 text-fg-quaternary"
        />
      </AriaButton>
      <Dropdown.Popover placement="top left" className="w-64">
        <Dropdown.Menu
          onAction={(key) => {
            if (key === "sign-out") void onSignOut?.();
          }}
        >
          <Dropdown.Item
            id="settings"
            label={m.navigation_personal_settings()}
            href={localizeHref("/settings")}
            icon={Settings01}
          />
          <Dropdown.Separator />
          <Dropdown.Item id="sign-out" label={m.controls_sign_out()} icon={LogOut} />
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}
