import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  ChevronDown,
  ChevronLeft,
  DotsHorizontal,
  Edit01 as Edit,
  File02 as FileText,
  LineChartUp01 as LineChart,
  Plus,
  SearchLg as Search,
  Settings01 as Settings,
} from "@untitledui/icons";

import { PageHeader } from "@/components/layout/page-header";
import { Avatar } from "@/components/base/avatar/avatar";
import { avatarInitial, avatarToneClassName } from "@/lib/avatar-tone";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Dropdown } from "@/components/base/dropdown/dropdown";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";
import {
  addCurrentWeeklyCycle,
  deleteWeeklyCycle,
  type loadRecordsCatalog,
} from "./records.functions";
export type RecordsTab = "weekly" | "notes";
export type RecordsPanel = "settings" | "stats";
export type RecordsCatalog = Awaited<ReturnType<typeof loadRecordsCatalog>>;

function recordsTabSearch(tab: string | undefined): RecordsTab {
  return tab === "notes" ? "notes" : "weekly";
}

const BackToRecordsContext = createContext<(() => void) | undefined>(undefined);

function matchesQuery(text: string, query: string) {
  if (!query) return true;
  return text.toLowerCase().includes(query.toLowerCase());
}

export function RecordsLayout({
  catalog,
  selectedRecordId,
  selectedPanel,
  tab,
  onTabChange,
  children,
}: {
  catalog: RecordsCatalog;
  selectedRecordId?: string;
  selectedPanel?: RecordsPanel | null;
  tab: RecordsTab;
  onTabChange: (tab: RecordsTab) => void;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const router = useRouter();
  const addCycle = useServerFn(addCurrentWeeklyCycle);
  const removeCycle = useServerFn(deleteWeeklyCycle);
  const [showMobileList, setShowMobileList] = useState(!selectedRecordId && !selectedPanel);
  const [query, setQuery] = useState("");
  const [favoritesOpen, setFavoritesOpen] = useState(true);
  const [highlightsOpen, setHighlightsOpen] = useState(true);
  const [myReportsOpen, setMyReportsOpen] = useState(true);
  const [membersOpen, setMembersOpen] = useState(true);
  const [expandedWeeks, setExpandedWeeks] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const detailOpen = Boolean(selectedRecordId || selectedPanel);
  const listHidden = detailOpen && !showMobileList;

  const filteredFavorites = useMemo(
    () => catalog.favorites.filter((item) => matchesQuery(item.title, query)),
    [catalog.favorites, query],
  );
  const filteredHighlights = useMemo(
    () => catalog.highlights.filter((item) => matchesQuery(item.title, query)),
    [catalog.highlights, query],
  );
  const filteredMyReports = useMemo(
    () => catalog.myReports.filter((item) => matchesQuery(item.title, query)),
    [catalog.myReports, query],
  );
  const filteredMemberWeeks = useMemo(
    () =>
      catalog.memberWeeks
        .map((week) => ({
          ...week,
          reports: week.reports.filter(
            (report) => matchesQuery(report.title, query) || matchesQuery(week.title, query),
          ),
        }))
        .filter((week) => {
          if (!query) return true;
          return matchesQuery(week.title, query) || week.reports.length > 0;
        }),
    [catalog.memberWeeks, query],
  );
  const filteredNotes = useMemo(
    () =>
      catalog.notes.filter(
        (note) => matchesQuery(note.title, query) || matchesQuery(note.preview, query),
      ),
    [catalog.notes, query],
  );

  async function onAddCycle() {
    if (busy) return;
    setBusy(true);
    try {
      await addCycle();
      setMembersOpen(true);
      await router.invalidate({ sync: true });
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteCycle(cycleId: string) {
    if (busy) return;
    setBusy(true);
    try {
      await removeCycle({ data: { cycleId } });
      await router.invalidate({ sync: true });
      if (selectedRecordId) {
        void navigate({
          to: "/records",
          search: (previous) => ({ tab: recordsTabSearch(previous.tab) }),
        });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex h-svh min-w-0 md:gap-2 md:p-2">
      <nav
        aria-label={m.records_list_label()}
        className={cn(
          "min-w-0 flex-col overflow-hidden bg-card md:flex md:w-72 md:shrink-0 md:rounded-xl md:border xl:w-80",
          listHidden ? "hidden" : "flex w-full",
        )}
      >
        <PageHeader heading={m.records_title()} />
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="space-y-3 px-3 pt-3">
            <label className="flex h-10 items-center gap-2 rounded-full bg-muted/60 px-3 text-sm ring-1 ring-border/60 ring-inset transition-shadow focus-within:bg-background focus-within:ring-2 focus-within:ring-ring">
              <Search aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={m.records_search_placeholder()}
                className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
              />
            </label>
            <div
              role="group"
              aria-label={m.records_title()}
              className="flex gap-4 border-b border-border px-1"
            >
              <TabButton
                active={tab === "weekly"}
                icon={<FileText aria-hidden="true" className="size-4" />}
                label={m.records_tab_weekly()}
                onClick={() => onTabChange("weekly")}
              />
              <TabButton
                active={tab === "notes"}
                icon={<Edit aria-hidden="true" className="size-4" />}
                label={m.records_tab_notes()}
                onClick={() => onTabChange("notes")}
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            {tab === "weekly" ? (
              <div className="space-y-5">
                <CollapsibleSection
                  title={m.records_section_favorites()}
                  open={favoritesOpen}
                  onOpenChange={setFavoritesOpen}
                >
                  {filteredFavorites.length === 0 ? (
                    <EmptyHint />
                  ) : (
                    <ul className="space-y-0.5">
                      {filteredFavorites.map((item) => (
                        <li key={item.id}>
                          <RecordLink
                            recordId={item.id}
                            selected={item.id === selectedRecordId}
                            onSelect={() => setShowMobileList(false)}
                          >
                            <Avatar
                              size="sm"
                              alt={item.author.displayName}
                              initials={avatarInitial(item.author.displayName)}
                              contentClassName={avatarToneClassName(item.author.displayName)}
                            />
                            <span className="truncate">{item.title}</span>
                          </RecordLink>
                        </li>
                      ))}
                    </ul>
                  )}
                </CollapsibleSection>

                <CollapsibleSection
                  title={m.records_section_highlights()}
                  open={highlightsOpen}
                  onOpenChange={setHighlightsOpen}
                >
                  {filteredHighlights.length === 0 ? (
                    <EmptyHint />
                  ) : (
                    <ul className="space-y-0.5">
                      {filteredHighlights.map((item) => (
                        <li key={item.id}>
                          <RecordLink
                            recordId={item.id}
                            selected={item.id === selectedRecordId}
                            onSelect={() => setShowMobileList(false)}
                          >
                            <WeekBadge week={item.week} />
                            <span className="truncate">{item.title}</span>
                          </RecordLink>
                        </li>
                      ))}
                    </ul>
                  )}
                </CollapsibleSection>

                <CollapsibleSection
                  title={m.records_section_mine()}
                  open={myReportsOpen}
                  onOpenChange={setMyReportsOpen}
                >
                  {filteredMyReports.length === 0 ? (
                    <EmptyHint />
                  ) : (
                    <ul className="space-y-0.5">
                      {filteredMyReports.map((item) => (
                        <li key={item.id}>
                          <RecordLink
                            recordId={item.id}
                            selected={item.id === selectedRecordId}
                            onSelect={() => setShowMobileList(false)}
                          >
                            <WeekBadge week={item.week} />
                            <span className="truncate">{item.title}</span>
                          </RecordLink>
                        </li>
                      ))}
                    </ul>
                  )}
                </CollapsibleSection>

                <CollapsibleSection
                  title={m.records_section_members()}
                  open={membersOpen}
                  onOpenChange={setMembersOpen}
                  actions={
                    <ButtonUtility
                      icon={Plus}
                      size="sm"
                      color="tertiary"
                      aria-label={m.records_add_member_week()}
                      isDisabled={busy}
                      onClick={() => void onAddCycle()}
                    />
                  }
                >
                  {filteredMemberWeeks.length === 0 ? (
                    <EmptyHint />
                  ) : (
                    <ul className="space-y-1">
                      {filteredMemberWeeks.map((week) => {
                        const expanded =
                          expandedWeeks[week.id] ?? (Boolean(query) && week.reports.length > 0);
                        return (
                          <li key={week.id} className="space-y-0.5">
                            <div className="flex min-w-0 items-center gap-1">
                              <ButtonUtility
                                icon={
                                  <ChevronDown
                                    aria-hidden="true"
                                    className={cn(
                                      "size-4 transition-transform",
                                      expanded && "rotate-180",
                                    )}
                                  />
                                }
                                size="sm"
                                color="tertiary"
                                className="size-7 shrink-0"
                                aria-expanded={expanded}
                                aria-label={
                                  expanded
                                    ? m.records_collapse_week({ week: week.title })
                                    : m.records_expand_week({ week: week.title })
                                }
                                onClick={() =>
                                  setExpandedWeeks((current) => ({
                                    ...current,
                                    [week.id]: !expanded,
                                  }))
                                }
                              />
                              {week.templateReport?.id || week.highlight?.id ? (
                                <RecordLink
                                  recordId={(week.templateReport?.id ?? week.highlight?.id)!}
                                  selected={
                                    week.templateReport?.id === selectedRecordId ||
                                    week.highlight?.id === selectedRecordId
                                  }
                                  onSelect={() => setShowMobileList(false)}
                                  className="min-w-0 flex-1"
                                >
                                  <span className="truncate font-medium">{week.title}</span>
                                  {week.latestTemplate && (
                                    <span className="ml-auto shrink-0 rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-medium text-brand">
                                      {m.records_latest_template()}
                                    </span>
                                  )}
                                </RecordLink>
                              ) : (
                                <div className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm">
                                  <span className="truncate font-medium">{week.title}</span>
                                </div>
                              )}
                              <WeekActionsMenu
                                weekTitle={week.title}
                                onDelete={() => void onDeleteCycle(week.id)}
                              />
                            </div>
                            {expanded && (
                              <ul className="ml-7 space-y-0.5">
                                {week.reports.map((report) => (
                                  <li key={report.id}>
                                    <RecordLink
                                      recordId={report.id}
                                      selected={report.id === selectedRecordId}
                                      onSelect={() => setShowMobileList(false)}
                                    >
                                      <Avatar
                                        size="sm"
                                        alt={report.author.displayName}
                                        initials={avatarInitial(report.author.displayName)}
                                        contentClassName={avatarToneClassName(
                                          report.author.displayName,
                                        )}
                                      />
                                      <span className="truncate">{report.title}</span>
                                    </RecordLink>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </CollapsibleSection>
              </div>
            ) : filteredNotes.length === 0 ? (
              <p className="px-1 py-6 text-sm text-muted-foreground">{m.records_notes_empty()}</p>
            ) : (
              <ul className="space-y-0.5">
                {filteredNotes.map((note) => (
                  <li key={note.id}>
                    <div className="rounded-lg px-2.5 py-2 text-sm">
                      <div className="font-medium">{note.title}</div>
                      <div className="text-xs text-muted-foreground">{note.preview}</div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="border-t border-secondary px-2 py-2">
            <Dropdown.Root>
              <ButtonUtility
                icon={Settings}
                size="sm"
                color="tertiary"
                className="size-9"
                aria-label={m.records_tools_menu()}
              />
              <Dropdown.Popover placement="top left" className="min-w-44">
                <Dropdown.Menu
                  aria-label={m.records_tools_menu()}
                  onAction={(key) => {
                    if (key === "stats") {
                      setShowMobileList(false);
                      const now = new Date();
                      void navigate({
                        to: "/records/stats",
                        search: (previous) => ({
                          tab: recordsTabSearch(previous.tab),
                          year:
                            typeof previous.year === "number" ? previous.year : now.getFullYear(),
                          month:
                            typeof previous.month === "number"
                              ? previous.month
                              : now.getMonth() + 1,
                        }),
                      });
                    } else if (key === "settings") {
                      setShowMobileList(false);
                      void navigate({
                        to: "/records/settings",
                        search: (previous) => ({ tab: recordsTabSearch(previous.tab) }),
                      });
                    }
                  }}
                >
                  <Dropdown.Item id="stats" label={m.records_stats()} icon={LineChart} />
                  <Dropdown.Item id="settings" label={m.records_settings()} icon={Settings} />
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown.Root>
          </div>
        </div>
      </nav>

      <section
        className={cn(
          "min-w-0 flex-1 flex-col overflow-hidden bg-card md:flex md:rounded-xl md:border",
          listHidden ? "flex" : "hidden md:flex",
        )}
      >
        <BackToRecordsContext value={() => setShowMobileList(true)}>
          {children}
        </BackToRecordsContext>
      </section>
    </main>
  );
}

function EmptyHint() {
  return <p className="px-1 py-2 text-xs text-muted-foreground">{m.records_section_empty()}</p>;
}

function TabButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      color="tertiary"
      aria-pressed={active}
      onPress={onClick}
      className={cn(
        "-mb-px h-auto rounded-none px-0.5 pb-2.5 hover:bg-transparent",
        active
          ? "border-b-2 border-primary text-primary hover:text-primary"
          : "border-b-2 border-transparent text-tertiary hover:text-primary",
      )}
    >
      {icon}
      {label}
    </Button>
  );
}

function CollapsibleSection({
  title,
  open,
  onOpenChange,
  actions,
  children,
}: {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-1.5 flex items-center gap-1">
        <Button
          type="button"
          color="tertiary"
          aria-expanded={open}
          onPress={() => onOpenChange(!open)}
          className="h-auto min-w-0 flex-1 justify-start gap-1 px-1 py-1 text-left text-xs font-semibold text-tertiary hover:bg-transparent hover:text-primary"
        >
          <ChevronDown
            aria-hidden="true"
            className={cn("size-3.5 transition-transform", open && "rotate-180")}
          />
          {title}
        </Button>
        {actions}
      </div>
      {open && children}
    </section>
  );
}

function WeekActionsMenu({ weekTitle, onDelete }: { weekTitle: string; onDelete: () => void }) {
  return (
    <Dropdown.Root>
      <ButtonUtility
        icon={DotsHorizontal}
        size="sm"
        color="tertiary"
        className="size-7 shrink-0"
        aria-label={`${m.records_week_actions()}: ${weekTitle}`}
      />
      <Dropdown.Popover placement="bottom end" className="min-w-36">
        <Dropdown.Menu
          aria-label={`${m.records_week_actions()}: ${weekTitle}`}
          onAction={() => onDelete()}
        >
          <Dropdown.Item id="delete" label={m.records_delete_week()} />
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}

function RecordLink({
  recordId,
  selected,
  onSelect,
  className,
  children,
}: {
  recordId: string;
  selected: boolean;
  onSelect: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link
      to="/records/$recordId"
      params={{ recordId }}
      search={(previous) => ({ tab: recordsTabSearch(previous.tab) })}
      aria-current={selected ? "page" : undefined}
      resetScroll={false}
      onClick={onSelect}
      className={cn(
        "flex min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        selected && "bg-muted font-medium",
        className,
      )}
    >
      {children}
    </Link>
  );
}

function WeekBadge({ week }: { week: number }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand/15 text-xs font-semibold text-brand"
    >
      {week}
    </span>
  );
}

export function BackToRecords() {
  const back = useContext(BackToRecordsContext);
  if (!back) return null;
  return (
    <ButtonUtility
      icon={ChevronLeft}
      size="sm"
      color="tertiary"
      className="md:hidden"
      aria-label={m.controls_back()}
      onClick={back}
    />
  );
}

export function EmptyRecord() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <p className="text-base font-semibold">{m.records_empty_title()}</p>
      <p className="max-w-sm text-sm text-muted-foreground">{m.records_empty_description()}</p>
    </div>
  );
}
