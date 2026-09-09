import { useEffect, useRef, useState } from "react";
import { formatForDisplay, useHotkey } from "@tanstack/react-hotkeys";
import { Link } from "@tanstack/react-router";
import { Group, Panel, Separator } from "react-resizable-panels";
import {
  UserCircle as CircleUserRound,
  CheckSquare as ListTodo,
  MessageCircle01 as MessageCircle,
  Monitor01 as Monitor,
  LayoutLeft as PanelLeft,
  LogOut01 as LogOut,
  Users01 as Users,
} from "@untitledui/icons";

import { MobileNavigationContext } from "@/components/layout/mobile-navigation";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { WorkspaceSwitcher, type WorkspaceOption } from "@/features/workspaces/workspace-switcher";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";

const sidebarShortcut = "Mod+B" as const;

// Untitled UI SidebarNavigationSimple / NavItemBase, adapted to CoForge's
// typed routing and existing 768px list/detail breakpoint (MIT; see ui notice).
const navLinkClassName =
  "flex h-10 items-center gap-3 rounded-lg px-3 text-sm font-semibold text-sidebar-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

const navLinkActiveProps = {
  className:
    "flex h-10 items-center gap-3 rounded-lg bg-sidebar-accent px-3 text-sm font-semibold text-sidebar-accent-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
  "aria-current": "page",
} as const;

const railLinkClassName =
  "relative flex size-10 items-center justify-center rounded-lg text-sidebar-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

const railLinkActiveProps = {
  className:
    "relative flex size-10 items-center justify-center rounded-lg bg-sidebar-accent text-sidebar-accent-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
  "aria-current": "page",
} as const;

export type AppUser = {
  name: string;
  email: string;
  avatarUrl?: string | null;
};

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
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const expandedSidebarWidth = useRef(240);

  useEffect(() => {
    const breakpoint = window.matchMedia("(max-width: 767px)");
    const closeDrawer = () => setMobileSidebarOpen(false);
    breakpoint.addEventListener("change", closeDrawer);
    return () => breakpoint.removeEventListener("change", closeDrawer);
  }, []);

  function toggleSidebar() {
    if (window.matchMedia("(max-width: 767px)").matches) {
      setMobileSidebarOpen((open) => !open);
    } else {
      setSidebarCollapsed((collapsed) => !collapsed);
    }
  }

  useHotkey(sidebarShortcut, toggleSidebar);
  useHotkey("Escape", () => setMobileSidebarOpen(false), { enabled: mobileSidebarOpen });

  return (
    <Group
      id="app-shell"
      orientation="horizontal"
      className="min-h-svh bg-background font-sans antialiased max-md:[&>#app-sidebar-panel]:contents! max-md:[&>#app-sidebar-panel>div]:contents! max-md:[&>#app-sidebar-rail-panel]:hidden! max-md:[&>#app-main-panel]:flex-1! md:bg-muted/30"
    >
      {(!sidebarCollapsed || mobileSidebarOpen) && (
        <Panel
          id="app-sidebar-panel"
          defaultSize={expandedSidebarWidth.current}
          minSize={200}
          maxSize={360}
          groupResizeBehavior="preserve-pixel-size"
          onResize={({ inPixels }) => {
            if (inPixels >= 200) expandedSidebarWidth.current = inPixels;
          }}
        >
          <aside
            id="app-sidebar"
            className={cn(
              "fixed inset-y-0 left-0 z-40 w-[80vw] max-w-72 shrink-0 flex-col overflow-y-auto border-r border-sidebar-border bg-background px-4 pt-4 pb-5 shadow-xl md:sticky md:top-0 md:flex md:h-svh md:w-full md:max-w-none md:border-r-0 md:bg-transparent md:shadow-none",
              mobileSidebarOpen ? "flex" : "hidden",
              sidebarCollapsed && "md:hidden",
            )}
          >
            <div className="flex h-12 items-center justify-between gap-3 px-1">
              <img src="/logo.svg" alt="CoForge" className="size-8" />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-11 md:size-8"
                      aria-label={m.controls_hide_sidebar()}
                      onClick={() => {
                        if (window.matchMedia("(max-width: 767px)").matches) {
                          setMobileSidebarOpen(false);
                        } else {
                          setSidebarCollapsed(true);
                        }
                      }}
                    >
                      <PanelLeft aria-hidden="true" />
                    </Button>
                  }
                />
                <TooltipContent>
                  {m.controls_hide_sidebar()}
                  <kbd data-slot="kbd">{formatForDisplay(sidebarShortcut)}</kbd>
                </TooltipContent>
              </Tooltip>
            </div>

            <div className="mt-5">
              <WorkspaceSwitcher
                workspaces={workspaces}
                current={currentWorkspace}
                onSelect={onSelectWorkspace}
                onCreate={onCreateWorkspace}
              />
            </div>

            <nav aria-label={m.navigation_label()} className="mt-5 flex flex-col gap-1">
              <Link
                to="/agents"
                activeProps={navLinkActiveProps}
                className={navLinkClassName}
                onClick={() => setMobileSidebarOpen(false)}
              >
                <Users aria-hidden="true" className="size-4" />
                {m.navigation_agents()}
              </Link>
              <Link
                to="/messages"
                activeProps={navLinkActiveProps}
                className={navLinkClassName}
                onClick={() => setMobileSidebarOpen(false)}
              >
                <MessageCircle aria-hidden="true" className="size-4" />
                {m.navigation_messages()}
              </Link>
              <Link
                to="/tasks"
                activeProps={navLinkActiveProps}
                className={navLinkClassName}
                onClick={() => setMobileSidebarOpen(false)}
              >
                <ListTodo aria-hidden="true" className="size-4" />
                {m.tasks_tab()}
              </Link>
              <Link
                to="/computers"
                activeProps={navLinkActiveProps}
                className={navLinkClassName}
                onClick={() => setMobileSidebarOpen(false)}
              >
                <Monitor aria-hidden="true" className="size-4" />
                {m.navigation_computers()}
              </Link>
            </nav>

            <div className="mt-auto border-t pt-4">
              <UserMenu
                user={user}
                expanded
                onSignOut={onSignOut}
                onNavigate={() => setMobileSidebarOpen(false)}
              />
            </div>
          </aside>
        </Panel>
      )}

      {!sidebarCollapsed && (
        <Separator
          id="app-sidebar-resize-handle"
          aria-label={m.controls_resize_sidebar()}
          className="relative z-20 hidden w-px bg-sidebar-border outline-none after:absolute after:inset-y-0 after:-left-1 after:w-2 hover:bg-ring focus-visible:bg-ring md:block"
        />
      )}

      {sidebarCollapsed && (
        <Panel id="app-sidebar-rail-panel" defaultSize={72} minSize={72} maxSize={72} disabled>
          <div
            data-sidebar-rail
            className="hidden w-full shrink-0 flex-col items-center bg-transparent pt-4 pb-5 md:sticky md:top-0 md:flex md:h-svh"
          >
            <div className="flex h-12 items-center">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-11 md:size-8"
                      aria-label={m.controls_show_sidebar()}
                      onClick={() => {
                        if (window.matchMedia("(max-width: 767px)").matches) {
                          setMobileSidebarOpen(true);
                        } else {
                          setSidebarCollapsed(false);
                        }
                      }}
                    >
                      <PanelLeft aria-hidden="true" />
                    </Button>
                  }
                />
                <TooltipContent>
                  {m.controls_show_sidebar()}
                  <kbd data-slot="kbd">{formatForDisplay(sidebarShortcut)}</kbd>
                </TooltipContent>
              </Tooltip>
            </div>

            {/* Collapsed navigation and user menu. Both are rendered only while
              collapsed, so the DOM never holds two copies of the same links. */}
            {sidebarCollapsed && (
              <>
                <nav
                  aria-label={m.navigation_label()}
                  className="mt-5 flex flex-col items-center gap-1"
                >
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Link
                          to="/agents"
                          aria-label={m.navigation_agents()}
                          activeProps={railLinkActiveProps}
                          className={railLinkClassName}
                        >
                          <Users aria-hidden="true" className="size-4" />
                        </Link>
                      }
                    />
                    <TooltipContent side="right">{m.navigation_agents()}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Link
                          to="/messages"
                          aria-label={m.navigation_messages()}
                          activeProps={railLinkActiveProps}
                          className={railLinkClassName}
                        >
                          <MessageCircle aria-hidden="true" className="size-4" />
                        </Link>
                      }
                    />
                    <TooltipContent side="right">{m.navigation_messages()}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Link
                          to="/tasks"
                          aria-label={m.tasks_tab()}
                          activeProps={railLinkActiveProps}
                          className={railLinkClassName}
                        >
                          <ListTodo aria-hidden="true" className="size-4" />
                        </Link>
                      }
                    />
                    <TooltipContent side="right">{m.tasks_tab()}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Link
                          to="/computers"
                          aria-label={m.navigation_computers()}
                          activeProps={railLinkActiveProps}
                          className={railLinkClassName}
                        >
                          <Monitor aria-hidden="true" className="size-4" />
                        </Link>
                      }
                    />
                    <TooltipContent side="right">{m.navigation_computers()}</TooltipContent>
                  </Tooltip>
                </nav>
                <div className="mt-auto">
                  <UserMenu user={user} />
                </div>
              </>
            )}
          </div>
        </Panel>
      )}

      <Panel id="app-main-panel" minSize={0} groupResizeBehavior="preserve-relative-size">
        <div className="flex min-w-0 flex-1 flex-col">
          {mobileSidebarOpen && (
            <Button
              type="button"
              variant="ghost"
              aria-label={m.controls_hide_sidebar()}
              className="fixed inset-0 z-30 h-auto rounded-none bg-black/50 p-0 hover:bg-black/50 md:hidden"
              onClick={() => setMobileSidebarOpen(false)}
            />
          )}
          <MobileNavigationContext
            value={{ open: mobileSidebarOpen, toggle: () => setMobileSidebarOpen((open) => !open) }}
          >
            {children}
          </MobileNavigationContext>
        </div>
      </Panel>
    </Group>
  );
}

function UserMenu({
  user,
  expanded = false,
  onSignOut,
  onNavigate,
}: {
  user: AppUser;
  expanded?: boolean;
  onSignOut?: () => Promise<void> | void;
  onNavigate?: () => void;
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        aria-label={m.controls_current_user()}
        className={cn(
          "flex items-center gap-3 rounded-lg p-2 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
          expanded && "w-full",
        )}
      >
        <Avatar people={[{ name: user.name, src: user.avatarUrl }]} size="lg" className="size-10" />
        {expanded && (
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold">{user.name}</span>
            <span className="block truncate text-xs text-muted-foreground">{user.email}</span>
          </span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-60 rounded-xl p-2 shadow-lg"
      >
        <div className="min-w-0 px-2 py-2">
          <span className="block truncate text-sm font-medium text-popover-foreground">
            {user.name}
          </span>
          <span className="block truncate text-xs text-muted-foreground">{user.email}</span>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="h-11 gap-2 px-2 md:h-10"
          href="/settings"
          render={
            <Link to="/settings" activeProps={{ "aria-current": "page" }} onClick={onNavigate}>
              <CircleUserRound aria-hidden="true" />
              {m.navigation_personal_settings()}
            </Link>
          }
        />
        <DropdownMenuItem
          className="h-11 gap-2 px-2 md:h-10"
          href={onSignOut ? undefined : "/auth/logout"}
          onClick={onSignOut ? () => void onSignOut() : undefined}
        >
          <LogOut aria-hidden="true" className="size-4 shrink-0" />
          {m.controls_sign_out()}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
