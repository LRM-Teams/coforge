import { createContext, useCallback, useContext, useState, type FC } from "react";
import { useHotkey } from "@tanstack/react-hotkeys";
import { useParams, useRouter, useRouterState } from "@tanstack/react-router";
import {
  ChevronSelectorVertical,
  CheckSquare as ListTodo,
  LogOut01 as LogOut,
  MessageChatSquare,
  Monitor01 as Monitor,
  Settings01,
  Users01 as Users,
} from "@untitledui/icons";
import { Button as AriaButton } from "react-aria-components";

import type { NavItemType } from "@/components/application/app-navigation/config";
import { Avatar } from "@/components/base/avatar/avatar";
import { Dropdown } from "@/components/base/dropdown/dropdown";
import type { SidebarChannel } from "@/components/layout/sidebar/sidebar-conversations";
import { SidebarRail } from "@/components/layout/sidebar/sidebar-rail";
import { MobileDrawerProvider } from "@/components/layout/sidebar/mobile-header";
import {
  ChannelSidebar,
  SidebarMobileDrawer,
  SIDEBAR_DEFAULT_WIDTH,
} from "@/components/layout/sidebar/sidebar-channels";
import { CreateChannelDialog } from "@/features/conversations/create-channel-dialog";
import type { ConversationAgent } from "@/features/conversations/conversation-layout";
import { WorkspaceSwitcher, type WorkspaceOption } from "@/features/workspaces/workspace-switcher";
import { avatarInitial, avatarToneClassName } from "@/lib/avatar-tone";
import { m } from "@/paraglide/messages";
import { localizeHref } from "@/paraglide/runtime";

const channelSidebarShortcut = "Mod+B" as const;

export type AppUser = {
  name: string;
  email: string;
  avatarUrl?: string | null;
};

function useNavItems(): (NavItemType & { icon: FC<{ className?: string }>; bareHref: string })[] {
  return [
    {
      label: m.navigation_chat(),
      bareHref: "/messages",
      href: localizeHref("/messages"),
      icon: MessageChatSquare,
    },
    {
      label: m.navigation_agents(),
      bareHref: "/agents",
      href: localizeHref("/agents"),
      icon: Users,
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

/** Lets a conversation header, rendered deep inside `children`, show its own
 * "show channels" control when AppShell's sidebar is hidden. */
export const ChannelSidebarVisibilityContext = createContext<{ hidden: boolean; show: () => void }>(
  {
    hidden: false,
    show: () => {},
  },
);

export function useChannelSidebarVisibility() {
  return useContext(ChannelSidebarVisibilityContext);
}

export function AppShell({
  user,
  workspaces = [],
  currentWorkspace = null,
  channels = [],
  agents = [],
  onSelectWorkspace,
  onCreateWorkspace,
  onCreateChannel,
  onSignOut,
  children,
}: {
  user: AppUser;
  workspaces?: WorkspaceOption[];
  currentWorkspace?: WorkspaceOption | null;
  /** Public channels, shown in the Channels sidebar (Slack model). */
  channels?: SidebarChannel[];
  /** Agents (with live status), shown as Direct messages under Channels. */
  agents?: ConversationAgent[];
  onSelectWorkspace?: (slug: string) => Promise<void> | void;
  onCreateWorkspace?: (input: { name: string; slug: string }) => Promise<void>;
  onCreateChannel?: (name: string) => Promise<void>;
  onSignOut?: () => Promise<void> | void;
  children: React.ReactNode;
}) {
  const [channelSidebarWidth, setChannelSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const [channelSidebarHidden, setChannelSidebarHidden] = useState(false);
  const [createChannelOpen, setCreateChannelOpen] = useState(false);
  // pathname is de-localized (src/router.tsx); item.href is localized, so we
  // match on bareHref (with sub-route prefix matching) instead.
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const navItems = useNavItems();
  const activeUrl = navItems.find(
    (item) => pathname === item.bareHref || pathname.startsWith(`${item.bareHref}/`),
  )?.href;
  const isChatRoute = pathname === "/messages" || pathname.startsWith("/messages/");
  const onSidebarClickCapture = useSpaNavigation();
  const agentParams = useParams({ from: "/_app/messages/$agentId", shouldThrow: false });
  const channelParams = useParams({
    from: "/_app/messages/channels/$channelId",
    shouldThrow: false,
  });

  useHotkey(channelSidebarShortcut, () => setChannelSidebarHidden((hidden) => !hidden));

  const conversationSections = {
    channels,
    agents,
    selectedChannelId: channelParams?.channelId,
    selectedAgentId: agentParams?.agentId,
    onCreateChannel: onCreateChannel ? () => setCreateChannelOpen(true) : undefined,
  };

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
            {...conversationSections}
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

          {isChatRoute && !channelSidebarHidden && (
            <ChannelSidebar
              workspaceName={currentWorkspace?.name}
              onHide={() => setChannelSidebarHidden(true)}
              width={channelSidebarWidth}
              onWidthChange={setChannelSidebarWidth}
              {...conversationSections}
            />
          )}
        </div>

        <ChannelSidebarVisibilityContext
          value={{
            hidden: isChatRoute && channelSidebarHidden,
            show: () => setChannelSidebarHidden(false),
          }}
        >
          <div className="flex min-w-0 flex-1 flex-col">{children}</div>
        </ChannelSidebarVisibilityContext>
        {onCreateChannel && (
          <CreateChannelDialog
            open={createChannelOpen}
            onOpenChange={setCreateChannelOpen}
            onCreate={onCreateChannel}
          />
        )}
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
