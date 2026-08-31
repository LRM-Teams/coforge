import { useState } from "react";
import { formatForDisplay, useHotkey } from "@tanstack/react-hotkeys";
import { Link } from "@tanstack/react-router";
import { CircleUserRound, MessageCircle, Monitor, PanelLeft, Users } from "lucide-react";

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
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";

const sidebarShortcut = "Mod+B" as const;

const navLinkClassName =
  "flex h-11 items-center gap-2.5 rounded-md px-2 text-sm text-sidebar-foreground hover:text-sidebar-accent-foreground md:h-9";

const navLinkActiveProps = {
  className:
    "relative flex h-11 items-center gap-2.5 rounded-md bg-sidebar-accent px-2 text-sm text-sidebar-accent-foreground before:absolute before:-left-3 before:h-5 before:w-0.5 before:rounded-r-full before:bg-brand md:h-9",
  "aria-current": "page",
} as const;

const railLinkClassName =
  "relative flex h-11 w-10 items-center justify-center rounded-md text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground md:h-9";

const railLinkActiveProps = {
  className:
    "relative flex h-11 w-10 items-center justify-center rounded-md bg-sidebar-accent text-sidebar-accent-foreground before:absolute before:-left-3 before:h-5 before:w-1 before:rounded-r-full before:bg-brand md:h-9",
  "aria-current": "page",
} as const;

export type AppUser = {
  name: string;
  email: string;
};

export function AppShell({ user, children }: { user: AppUser; children: React.ReactNode }) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  function toggleSidebar() {
    if (window.matchMedia("(max-width: 767px)").matches) {
      setMobileSidebarOpen((open) => !open);
    } else {
      setSidebarCollapsed((collapsed) => !collapsed);
    }
  }

  useHotkey(sidebarShortcut, toggleSidebar);

  return (
    <div className="flex min-h-svh bg-sidebar">
      {mobileSidebarOpen && (
        <button
          type="button"
          aria-label={m.controls_hide_sidebar()}
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          onClick={() => setMobileSidebarOpen(false)}
        />
      )}
      {(!sidebarCollapsed || mobileSidebarOpen) && (
        <aside
          className={cn(
            "fixed inset-y-0 left-0 z-40 w-[72vw] max-w-72 shrink-0 flex-col border-r border-sidebar-border bg-sidebar px-3 pt-2 pb-6 shadow-xl md:border-r-0 md:sticky md:top-0 md:flex md:h-svh md:w-52 md:max-w-none md:shadow-none",
            mobileSidebarOpen ? "flex" : "hidden",
            !sidebarCollapsed && "md:flex",
          )}
        >
          {/* The 8px gutter plus the 1px card border, so the logo sits on the
              same line as every page title. */}
          <div className="mt-px flex h-14 items-center justify-between">
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

          <nav aria-label={m.navigation_label()} className="mt-5 flex flex-col gap-1 md:gap-2.5">
            <Link to="/" activeProps={navLinkActiveProps} className={navLinkClassName}>
              <Users aria-hidden="true" className="size-4" />
              {m.navigation_members()}
            </Link>
            <Link to="/messages" activeProps={navLinkActiveProps} className={navLinkClassName}>
              <MessageCircle aria-hidden="true" className="size-4" />
              {m.navigation_messages()}
            </Link>
            <Link to="/computers" activeProps={navLinkActiveProps} className={navLinkClassName}>
              <Monitor aria-hidden="true" className="size-4" />
              {m.navigation_computers()}
            </Link>
          </nav>

          <div className="mt-auto">
            <UserMenu user={user} />
          </div>
        </aside>
      )}

      {(sidebarCollapsed || !mobileSidebarOpen) && (
        <div
          className={cn(
            "flex w-16 shrink-0 flex-col items-center pb-6 md:sticky md:top-0 md:h-svh",
            !sidebarCollapsed && "md:hidden",
          )}
        >
          {/* The 8px gutter plus the 1px card border, so the control sits on the
              same line as every page title. */}
          <div className="mt-px flex h-14 items-center pt-2">
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
                className="mt-5 flex flex-col items-center gap-3"
              >
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Link
                        to="/"
                        aria-label={m.navigation_members()}
                        activeProps={railLinkActiveProps}
                        className={railLinkClassName}
                      >
                        <Users aria-hidden="true" className="size-4" />
                      </Link>
                    }
                  />
                  <TooltipContent side="right">{m.navigation_members()}</TooltipContent>
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
      )}

      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

function UserMenu({ user }: { user: AppUser }) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        aria-label={m.controls_current_user()}
        className="flex items-center rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <Avatar people={[{ name: user.name }]} size="lg" className="md:size-8" />
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
          render={
            <Link to="/settings" activeProps={{ "aria-current": "page" }}>
              <CircleUserRound aria-hidden="true" />
              {m.navigation_personal_settings()}
            </Link>
          }
        />
        <DropdownMenuItem
          className="h-11 gap-2 px-2 md:h-10"
          render={<a href="/auth/logout">{m.controls_sign_out()}</a>}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
