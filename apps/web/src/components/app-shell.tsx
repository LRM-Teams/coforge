import { useState } from "react";
import { formatForDisplay, useHotkey } from "@tanstack/react-hotkeys";
import { Link } from "@tanstack/react-router";
import { CircleUserRound, Monitor, PanelLeft, Users } from "lucide-react";

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
            "fixed inset-y-0 left-0 z-40 w-[72vw] max-w-72 shrink-0 flex-col border-r border-sidebar-border [background:var(--sidebar-background)] px-3 py-6 shadow-xl md:sticky md:top-0 md:flex md:h-svh md:w-52 md:max-w-none md:shadow-none",
            mobileSidebarOpen ? "flex" : "hidden",
            !sidebarCollapsed && "md:flex",
          )}
        >
          <div className="mb-7 flex items-center justify-between">
            <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-sm font-semibold text-primary-foreground">
              C
            </div>
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

          <nav aria-label={m.navigation_label()} className="flex flex-col gap-1 md:gap-2.5">
            <Link
              to="/"
              activeProps={{
                className:
                  "relative flex h-11 items-center gap-2.5 rounded-[4px] bg-sidebar-accent px-2 text-sm text-sidebar-accent-foreground before:absolute before:-left-3 before:h-5 before:w-0.5 before:rounded-r-full before:bg-brand md:h-9",
                "aria-current": "page",
              }}
              className="flex h-11 items-center gap-2.5 rounded-[4px] px-2 text-sm text-sidebar-foreground hover:text-sidebar-accent-foreground md:h-9"
            >
              <Users aria-hidden="true" className="size-4" />
              {m.navigation_members()}
            </Link>
            <Link
              to="/computers"
              activeProps={{
                className:
                  "relative flex h-11 items-center gap-2.5 rounded-[4px] bg-sidebar-accent px-2 text-sm text-sidebar-accent-foreground before:absolute before:-left-3 before:h-5 before:w-0.5 before:rounded-r-full before:bg-brand md:h-9",
                "aria-current": "page",
              }}
              className="flex h-11 items-center gap-2.5 rounded-[4px] px-2 text-sm text-sidebar-foreground hover:text-sidebar-accent-foreground md:h-9"
            >
              <Monitor aria-hidden="true" className="size-4" />
              {m.navigation_computers()}
            </Link>
          </nav>

          <div className="mt-auto">
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger
                aria-label={m.controls_current_user()}
                className="flex size-11 items-center justify-center rounded-full border bg-card text-xs font-medium outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 md:size-8"
              >
                {userInitial(user.name)}
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
          </div>
        </aside>
      )}

      <div className="flex min-w-0 flex-1 flex-col bg-background">
        <header className="flex h-14 shrink-0 items-center border-b px-3 sm:px-5">
          {(sidebarCollapsed || !mobileSidebarOpen) && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn("mr-2 sm:mr-3", !sidebarCollapsed && "md:hidden")}
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
          )}
          <span className="text-sm font-medium">CoForge</span>
        </header>

        {children}
      </div>
    </div>
  );
}

function userInitial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "?";
}
