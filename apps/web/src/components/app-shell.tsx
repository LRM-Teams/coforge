import { useEffect, useState } from "react";
import { formatForDisplay, useHotkey } from "@tanstack/react-hotkeys";
import {
  Bell,
  ChevronDown,
  CircleUserRound,
  Clock3,
  Folder,
  MessageCircle,
  Monitor,
  PanelLeft,
  Plus,
  Search,
  Users,
} from "lucide-react";

import { AgentCard } from "@/components/agent-card";
import { SettingsContent } from "@/components/settings-content";
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
import { getLocale, localizeHref, setLocale } from "@/paraglide/runtime";

const navigation = [
  { label: m.navigation_overview, href: "#overview", icon: Clock3, current: false },
  { label: m.navigation_search, href: "#search", icon: Search, current: false },
  { label: m.navigation_notifications, href: "#notifications", icon: Bell, current: false },
  {
    label: m.navigation_conversations,
    href: "#conversations",
    icon: MessageCircle,
    current: false,
  },
  { label: m.navigation_projects, href: "#projects", icon: Folder, current: false },
  { label: m.navigation_members, href: "#members", icon: Users, current: true },
  { label: m.navigation_computers, href: "#computers", icon: Monitor, current: false },
] as const;

const sidebarShortcut = "Mod+B" as const;

type Theme = "system" | "light" | "dark";
type Page = "members" | "settings";

export function AppShell({ page = "members" }: { page?: Page }) {
  const locale = getLocale();
  const [theme, setTheme] = useState<Theme>("system");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  useEffect(() => {
    const storedTheme = localStorage.getItem("coforge-theme");
    const initialTheme =
      storedTheme === "system" || storedTheme === "dark" || storedTheme === "light"
        ? storedTheme
        : "system";
    setTheme(initialTheme);
    applyTheme(initialTheme);
  }, []);

  useEffect(() => {
    if (theme !== "system") {
      return;
    }

    const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => applyTheme("system");
    colorScheme.addEventListener("change", handleChange);
    return () => colorScheme.removeEventListener("change", handleChange);
  }, [theme]);

  function applyTheme(nextTheme: Theme) {
    const dark =
      nextTheme === "dark" ||
      (nextTheme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
  }

  function toggleSidebar() {
    if (window.matchMedia("(max-width: 767px)").matches) {
      setMobileSidebarOpen((open) => !open);
    } else {
      setSidebarCollapsed((collapsed) => !collapsed);
    }
  }

  useHotkey(sidebarShortcut, toggleSidebar);

  function setThemePreference(nextTheme: Theme) {
    setTheme(nextTheme);
    localStorage.setItem("coforge-theme", nextTheme);
    applyTheme(nextTheme);
  }

  const agents = [
    {
      name: "Atlas",
      handle: "hr-assistant",
      role: m.agent_atlas_role(),
      description: m.agent_atlas_description(),
      computer: "PengdeMacBook",
      owner: "James",
      initials: "AT",
      avatarClassName: "bg-[#7556b9]",
    },
    {
      name: "John",
      handle: "product-designer-assistant",
      role: m.agent_john_role(),
      description: m.agent_john_description(),
      computer: "docker-test0813",
      owner: "Wangli",
      initials: "JO",
      avatarClassName: "bg-[#d18a38]",
    },
    {
      name: "Judy",
      handle: "backend",
      role: m.agent_judy_role(),
      description: m.agent_judy_description(),
      computer: "FrankAns-MacBook",
      owner: "James",
      initials: "JU",
      avatarClassName: "bg-[#b65757]",
    },
    {
      name: "Mark",
      handle: "markassistant",
      role: m.agent_mark_role(),
      description: m.agent_mark_description(),
      computer: "PengdeMacBook",
      owner: "James",
      initials: "MA",
      avatarClassName: "bg-[#5268b7]",
    },
    {
      name: "Tick",
      handle: "ui-designer-assistant",
      role: m.agent_tick_role(),
      description: m.agent_tick_description(),
      computer: "docker-test0813",
      owner: "Wangli",
      initials: "TI",
      avatarClassName: "bg-[#497665]",
    },
    {
      name: "Tony",
      handle: "Tonyassistant",
      role: m.agent_tony_role(),
      description: m.agent_tony_description(),
      computer: "FrankAns-MacBook",
      owner: "James",
      initials: "TO",
      avatarClassName: "bg-[#ba5937]",
    },
  ];

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
            {navigation.map(({ label, href, icon: Icon, current }) => (
              <a
                key={href}
                href={href}
                aria-current={current && page === "members" ? "page" : undefined}
                className={
                  current && page === "members"
                    ? "relative flex h-11 items-center gap-2.5 rounded-[4px] bg-sidebar-accent px-2 text-sm text-sidebar-accent-foreground before:absolute before:-left-3 before:h-5 before:w-0.5 before:rounded-r-full before:bg-brand md:h-9"
                    : "flex h-11 items-center gap-2.5 rounded-[4px] px-2 text-sm text-sidebar-foreground hover:text-sidebar-accent-foreground md:h-9"
                }
              >
                <Icon aria-hidden="true" className="size-4" />
                {label()}
              </a>
            ))}
          </nav>

          <div className="mt-auto">
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger
                aria-label={m.controls_current_user()}
                className="flex size-11 items-center justify-center rounded-full border bg-card text-xs font-medium outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 md:size-8"
              >
                F
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="top"
                align="start"
                sideOffset={8}
                className="w-60 rounded-xl p-2 shadow-lg"
              >
                <div className="min-w-0 px-2 py-2">
                  <span className="block truncate text-sm font-medium text-popover-foreground">
                    Frank An
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">@frankan</span>
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="h-11 gap-2 px-2 md:h-10"
                  render={
                    <a
                      href={localizeHref("/settings")}
                      aria-current={page === "settings" ? "page" : undefined}
                    >
                      <CircleUserRound aria-hidden="true" />
                      {m.navigation_personal_settings()}
                    </a>
                  }
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
          {page === "members" ? (
            <>
              <div className="flex min-w-0 items-center gap-2 text-sm sm:gap-3">
                <span className="font-medium">{m.header_agents()}</span>
                <span className="text-xs text-muted-foreground">24</span>
                <span className="hidden text-border sm:inline">/</span>
                <span className="hidden text-muted-foreground sm:inline">
                  {m.header_collaborators()}
                </span>
                <span className="hidden text-xs text-muted-foreground sm:inline">21</span>
              </div>
              <Button className="ml-auto shrink-0" aria-label={m.header_new_agent()}>
                <Plus aria-hidden="true" data-icon="inline-start" />
                <span className="hidden sm:inline">{m.header_new_agent()}</span>
              </Button>
            </>
          ) : (
            <span className="text-sm font-medium">{m.navigation_settings()}</span>
          )}
        </header>

        {page === "settings" ? (
          <SettingsContent
            locale={locale}
            theme={theme}
            onLocaleChange={(nextLocale) => setLocale(nextLocale)}
            onThemeChange={setThemePreference}
          />
        ) : (
          <main className="flex-1 p-4 sm:p-5 md:p-6">
            <div className="flex flex-col items-start gap-4 sm:flex-row sm:justify-between sm:gap-6">
              <div>
                <h1 className="text-xl font-semibold tracking-tight">{m.content_title()}</h1>
                <p className="mt-2 text-sm text-muted-foreground">{m.content_description()}</p>
              </div>
              <Button variant="outline">{m.content_archived_agents()}</Button>
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-3 sm:mt-7">
              <div className="flex h-9 items-center rounded-md border bg-muted p-0.5 text-xs">
                <button className="h-7 rounded px-5 text-muted-foreground">
                  {m.filters_mine()}
                </button>
                <button className="h-7 rounded border bg-background px-5 font-medium shadow-xs">
                  {m.filters_all()}
                </button>
              </div>
              <button className="flex h-9 min-w-28 flex-1 items-center justify-between gap-4 rounded-md border bg-background px-3 text-xs sm:flex-none">
                {m.filters_computer()}
                <ChevronDown aria-hidden="true" className="size-3.5 text-muted-foreground" />
              </button>
              <label className="flex h-9 w-full items-center gap-2 rounded-md border bg-background px-3 text-xs focus-within:ring-2 focus-within:ring-ring/30 sm:w-64">
                <Search aria-hidden="true" className="size-4 text-muted-foreground" />
                <input
                  type="search"
                  aria-label={m.filters_search()}
                  placeholder={`${m.filters_search()}...`}
                  className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
                />
              </label>
            </div>

            <section className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {agents.map((agent) => (
                <AgentCard key={agent.name} {...agent} />
              ))}
            </section>
          </main>
        )}
      </div>
    </div>
  );
}
