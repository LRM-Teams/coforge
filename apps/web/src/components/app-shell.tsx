import { useCallback, useEffect, type FC } from "react";
import { useRouter, useRouterState } from "@tanstack/react-router";
import {
  Activity,
  ChevronSelectorVertical,
  CheckSquare as ListTodo,
  File02 as FileText,
  Folder,
  LogOut01 as LogOut,
  MessageChatSquare,
  Monitor01 as Monitor,
  Settings01,
  Users01 as Users,
} from "@untitledui/icons";
import { Button as AriaButton } from "react-aria-components";

import type { NavItemType } from "#src/components/application/app-navigation/config";
import { Avatar } from "#src/components/base/avatar/avatar";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { SidebarRail } from "#src/components/layout/sidebar/sidebar-rail";
import { MobileDrawerProvider } from "#src/components/layout/sidebar/mobile-header";
import { SidebarMobileDrawer } from "#src/components/layout/sidebar/sidebar-channels";
import {
  DEFAULT_RECORDS_NAV_HREF,
  rememberRecordsLastPath,
  recordsNavHref,
} from "#src/features/records/records-last-path";
import {
  WorkspaceSwitcher,
  type WorkspaceOption,
} from "#src/features/workspaces/workspace-switcher";
import { avatarInitial, avatarToneClassName } from "#src/lib/avatar-tone";
import { m } from "#src/paraglide/messages";
import { localizeHref } from "#src/paraglide/runtime";

export type AppUser = {
  name: string;
  email: string;
  avatarUrl?: string | null;
};

function useNavItems(
  recordsPreview = false,
  workspaceId?: string,
): (NavItemType & { icon: FC<{ className?: string }>; bareHref: string })[] {
  const recordsDot = recordsPreview ? (
    <span className="ml-auto size-1.5 shrink-0 rounded-full bg-brand-solid" />
  ) : undefined;
  const recordsHref = workspaceId ? recordsNavHref(workspaceId) : DEFAULT_RECORDS_NAV_HREF;
  return [
    {
      label: m.navigation_chat(),
      bareHref: "/messages",
      href: localizeHref("/messages"),
      icon: MessageChatSquare,
    },
    {
      label: m.navigation_activity(),
      bareHref: "/activity",
      href: localizeHref("/activity"),
      icon: Activity,
    },
    {
      label: m.projects_title(),
      bareHref: "/projects",
      href: localizeHref("/projects"),
      icon: Folder,
    },
    {
      label: m.navigation_agents(),
      bareHref: "/agents",
      href: localizeHref("/agents"),
      icon: Users,
    },
    { label: m.tasks_tab(), bareHref: "/tasks", href: localizeHref("/tasks"), icon: ListTodo },
    {
      label: m.navigation_records(),
      bareHref: "/records",
      href: localizeHref(recordsHref),
      icon: FileText,
      badge: recordsDot,
    },
    {
      label: m.navigation_computers(),
      bareHref: "/computers",
      href: localizeHref("/computers"),
      icon: Monitor,
    },
  ];
}

/** Official nav components render plain `<a href>` with no onClick hook, so
 * this routes same-origin, unmodified clicks through the router instead. */
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
  recordsPreview = false,
}: {
  user: AppUser;
  workspaces?: WorkspaceOption[];
  currentWorkspace?: WorkspaceOption | null;
  onSelectWorkspace?: (slug: string) => Promise<void> | void;
  onCreateWorkspace?: (input: { name: string; slug: string }) => Promise<void>;
  onSignOut?: () => Promise<void> | void;
  /** Purple dot on 记录 for a Leader preview hour or an unread member assignment. */
  recordsPreview?: boolean;
  children: React.ReactNode;
}) {
  // pathname is de-localized (src/router.tsx); item.href is localized, so we
  // match on bareHref (with sub-route prefix matching) instead.
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const searchStr = useRouterState({ select: (state) => state.location.searchStr });
  const workspaceId = currentWorkspace?.id;
  useEffect(() => {
    if (!workspaceId || !pathname.startsWith("/records")) return;
    const search = !searchStr ? "" : searchStr.startsWith("?") ? searchStr : `?${searchStr}`;
    rememberRecordsLastPath(workspaceId, `${pathname}${search}`);
  }, [workspaceId, pathname, searchStr]);
  const navItems = useNavItems(recordsPreview, workspaceId);
  const activeUrl = navItems.find(
    (item) => pathname === item.bareHref || pathname.startsWith(`${item.bareHref}/`),
  )?.href;
  const onSidebarClickCapture = useSpaNavigation();

  return (
    <MobileDrawerProvider>
      <div className="flex h-svh flex-col bg-primary font-body antialiased lg:flex-row">
        {/* Each sidebar is `fixed` + a spacer div reserving its width in flow;
          `contents` keeps that pair as direct flex items of this `lg:flex` shell. */}
        <div onClickCapture={onSidebarClickCapture} className="contents">
          <SidebarMobileDrawer
            activeUrl={activeUrl}
            items={navItems}
            subheader={
              <WorkspaceSwitcher
                workspaces={workspaces}
                current={currentWorkspace}
                onSelect={onSelectWorkspace}
                onCreate={onCreateWorkspace}
              />
            }
            footer={<UserMenuCard user={user} onSignOut={onSignOut} />}
          />
          <SidebarRail
            activeUrl={activeUrl}
            items={navItems}
            subheader={
              <WorkspaceSwitcher
                compact
                workspaces={workspaces}
                current={currentWorkspace}
                onSelect={onSelectWorkspace}
                onCreate={onCreateWorkspace}
              />
            }
            footer={<UserMenuCard compact user={user} onSignOut={onSignOut} />}
          />
        </div>

        <div className="flex min-w-0 flex-1 flex-col">{children}</div>
      </div>
    </MobileDrawerProvider>
  );
}

function UserMenuCard({
  user,
  onSignOut,
  compact = false,
}: {
  user: AppUser;
  onSignOut?: () => Promise<void> | void;
  compact?: boolean;
}) {
  const avatar = (
    <Avatar
      size={compact ? "sm" : "md"}
      src={user.avatarUrl}
      alt={user.name}
      initials={avatarInitial(user.name)}
      contentClassName={avatarToneClassName(user.name)}
    />
  );
  return (
    <Dropdown.Root>
      {compact ? (
        <AriaButton
          aria-label={`${m.controls_current_user()}: ${user.name}`}
          className="relative flex size-8 items-center justify-center rounded-full outline-focus-ring transition duration-100 ease-linear focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {avatar}
        </AriaButton>
      ) : (
        <AriaButton
          aria-label={m.controls_current_user()}
          className="relative flex w-full items-center gap-3 rounded-xl p-3 text-left outline-focus-ring ring-1 ring-secondary transition duration-100 ease-linear ring-inset hover:bg-primary_hover focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {avatar}
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-primary">
            {user.name}
          </span>
          <ChevronSelectorVertical
            aria-hidden="true"
            className="size-4 shrink-0 text-fg-quaternary"
          />
        </AriaButton>
      )}
      <Dropdown.Popover placement={compact ? "right bottom" : "top left"} className="w-64">
        <div className="border-b border-secondary px-3.5 py-3">
          <p className="truncate text-sm font-semibold text-primary">{user.name}</p>
          <p className="truncate text-xs text-tertiary">{user.email}</p>
        </div>
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
