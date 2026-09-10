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
import { Button, buttonVariants } from "./report-editor/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./report-editor/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";
import { CreateMemberReportDialog } from "./create-member-report-dialog";
import { currentIsoWeek, memberReportTitle, memberWeekTitle } from "./records-content";
import {
  createMemberWeeklyReport,
  createTemplateWeeklyReport,
  createWeeklyHighlight,
  deleteTemplateWeeklyReport,
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

function defaultMemberReportTitle(displayName: string) {
  const { year, week } = currentIsoWeek();
  return memberReportTitle(displayName || "Member", year, week);
}

function defaultTemplateReportTitle() {
  const { year, week } = currentIsoWeek();
  return memberWeekTitle(year, week);
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
  const createHighlight = useServerFn(createWeeklyHighlight);
  const createMemberReport = useServerFn(createMemberWeeklyReport);
  const createTemplateReport = useServerFn(createTemplateWeeklyReport);
  const removeTemplate = useServerFn(deleteTemplateWeeklyReport);
  const [showMobileList, setShowMobileList] = useState(!selectedRecordId && !selectedPanel);
  const [query, setQuery] = useState("");
  const [favoritesOpen, setFavoritesOpen] = useState(true);
  const [highlightsOpen, setHighlightsOpen] = useState(true);
  const [myReportsOpen, setMyReportsOpen] = useState(true);
  const [membersOpen, setMembersOpen] = useState(true);
  const [expandedTemplates, setExpandedTemplates] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [createReportKind, setCreateReportKind] = useState<"member" | "template" | null>(null);
  const detailOpen = Boolean(selectedRecordId || selectedPanel);
  const listHidden = detailOpen && !showMobileList;
  const createReportDefaultTitle =
    createReportKind === "template"
      ? defaultTemplateReportTitle()
      : defaultMemberReportTitle(catalog.actorDisplayName);

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
  const filteredMemberTemplates = useMemo(
    () =>
      catalog.memberTemplates
        .map((template) => ({
          ...template,
          submissions: template.submissions.filter(
            (submission) =>
              matchesQuery(submission.title, query) ||
              matchesQuery(submission.author.displayName, query) ||
              matchesQuery(template.title, query),
          ),
        }))
        .filter((template) => {
          if (!query) return true;
          return matchesQuery(template.title, query) || template.submissions.length > 0;
        }),
    [catalog.memberTemplates, query],
  );
  const filteredNotes = useMemo(
    () =>
      catalog.notes.filter(
        (note) => matchesQuery(note.title, query) || matchesQuery(note.preview, query),
      ),
    [catalog.notes, query],
  );

  async function openCreatedRecord(recordId: string) {
    setShowMobileList(false);
    await router.invalidate({ sync: true });
    void navigate({
      to: "/records/$recordId",
      params: { recordId },
      search: (previous) => ({ tab: recordsTabSearch(previous.tab) }),
    });
  }

  async function onCreateHighlight() {
    if (busy) return;
    setBusy(true);
    try {
      const result = await createHighlight();
      setHighlightsOpen(true);
      await openCreatedRecord(result.id);
    } finally {
      setBusy(false);
    }
  }

  async function onCreateReport(title: string) {
    if (createReportKind === "template") {
      const result = await createTemplateReport({ data: { title } });
      setMembersOpen(true);
      void openCreatedRecord(result.id);
      return;
    }
    const result = await createMemberReport({ data: { title } });
    setMyReportsOpen(true);
    void openCreatedRecord(result.id);
  }

  async function onDeleteTemplate(reportId: string) {
    if (busy) return;
    setBusy(true);
    try {
      await removeTemplate({ data: { reportId } });
      await router.invalidate({ sync: true });
      if (selectedRecordId === reportId) {
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
                  actions={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={m.records_add_highlight()}
                      disabled={busy}
                      onClick={() => void onCreateHighlight()}
                    >
                      <Plus aria-hidden="true" className="size-4" />
                    </Button>
                  }
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
                  actions={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={m.records_add_my_report()}
                      onClick={() => setCreateReportKind("member")}
                    >
                      <Plus aria-hidden="true" className="size-4" />
                    </Button>
                  }
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
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={m.records_add_member_week()}
                      onClick={() => setCreateReportKind("template")}
                    >
                      <Plus aria-hidden="true" className="size-4" />
                    </Button>
                  }
                >
                  {filteredMemberTemplates.length === 0 ? (
                    <EmptyHint />
                  ) : (
                    <ul className="space-y-1">
                      {filteredMemberTemplates.map((template) => {
                        const hasSubmissions = template.submissions.length > 0;
                        const expanded =
                          expandedTemplates[template.id] ?? (Boolean(query) && hasSubmissions);
                        const selected =
                          template.id === selectedRecordId ||
                          template.submissions.some((item) => item.id === selectedRecordId);
                        return (
                          <li key={template.id} className="space-y-0.5">
                            <div
                              className={cn(
                                "flex min-w-0 items-center gap-1 rounded-lg",
                                selected && "ring-1 ring-ring",
                              )}
                            >
                              {hasSubmissions ? (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-xs"
                                  className="size-7 shrink-0"
                                  aria-expanded={expanded}
                                  aria-label={
                                    expanded
                                      ? m.records_collapse_week({ week: template.title })
                                      : m.records_expand_week({ week: template.title })
                                  }
                                  onClick={() =>
                                    setExpandedTemplates((current) => ({
                                      ...current,
                                      [template.id]: !expanded,
                                    }))
                                  }
                                >
                                  <ChevronDown
                                    aria-hidden="true"
                                    className={cn(
                                      "size-4 transition-transform",
                                      expanded && "rotate-180",
                                    )}
                                  />
                                </Button>
                              ) : (
                                <span className="size-7 shrink-0" aria-hidden="true" />
                              )}
                              <RecordLink
                                recordId={template.id}
                                selected={template.id === selectedRecordId}
                                onSelect={() => setShowMobileList(false)}
                                className="min-w-0 flex-1"
                              >
                                <span className="truncate font-medium">{template.title}</span>
                                {template.latestTemplate && (
                                  <span className="ml-auto shrink-0 rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-medium text-brand">
                                    {m.records_latest_template()}
                                  </span>
                                )}
                              </RecordLink>
                              <TemplateActionsMenu
                                title={template.title}
                                onDelete={() => void onDeleteTemplate(template.id)}
                              />
                            </div>
                            {hasSubmissions && expanded && (
                              <ul className="ml-7 space-y-0.5">
                                {template.submissions.map((submission) => (
                                  <li key={submission.id}>
                                    <RecordLink
                                      recordId={submission.id}
                                      selected={submission.id === selectedRecordId}
                                      onSelect={() => setShowMobileList(false)}
                                    >
                                      <Avatar
                                        size="sm"
                                        initials={avatarInitial(submission.author.displayName)}
                                        contentClassName={avatarToneClassName(
                                          submission.author.displayName,
                                        )}
                                      />
                                      <span className="truncate">{submission.title}</span>
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

          <div className="border-t px-2 py-2">
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger
                aria-label={m.records_tools_menu()}
                className={buttonVariants({
                  variant: "ghost",
                  size: "icon",
                  className: "size-9 text-muted-foreground",
                })}
              >
                <Settings aria-hidden="true" className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="min-w-44">
                <DropdownMenuItem
                  onClick={() => {
                    setShowMobileList(false);
                    const now = new Date();
                    void navigate({
                      to: "/records/stats",
                      search: (previous) => ({
                        tab: recordsTabSearch(previous.tab),
                        year: typeof previous.year === "number" ? previous.year : now.getFullYear(),
                        month:
                          typeof previous.month === "number" ? previous.month : now.getMonth() + 1,
                      }),
                    });
                  }}
                >
                  <LineChart aria-hidden="true" className="size-4" />
                  {m.records_stats()}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    setShowMobileList(false);
                    void navigate({
                      to: "/records/settings",
                      search: (previous) => ({ tab: recordsTabSearch(previous.tab) }),
                    });
                  }}
                >
                  <Settings aria-hidden="true" className="size-4" />
                  {m.records_settings()}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
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

      <CreateMemberReportDialog
        open={createReportKind !== null}
        onOpenChange={(open) => {
          if (!open) setCreateReportKind(null);
        }}
        defaultTitle={createReportDefaultTitle}
        onCreate={onCreateReport}
      />
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
      variant="ghost"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "-mb-px h-auto rounded-none px-0.5 pb-2.5 hover:bg-transparent",
        active
          ? "border-b-2 border-foreground text-foreground hover:text-foreground"
          : "border-b-2 border-transparent text-muted-foreground hover:text-foreground",
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
          variant="ghost"
          aria-expanded={open}
          onClick={() => onOpenChange(!open)}
          className="h-auto min-w-0 flex-1 justify-start gap-1 px-1 py-1 text-left text-xs font-semibold text-muted-foreground hover:bg-transparent hover:text-foreground"
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

function TemplateActionsMenu({ title, onDelete }: { title: string; onDelete: () => void }) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        aria-label={`${m.records_week_actions()}: ${title}`}
        className={buttonVariants({
          variant: "ghost",
          size: "icon-xs",
          className: "size-7 shrink-0 text-muted-foreground",
        })}
      >
        <DotsHorizontal aria-hidden="true" className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-36">
        <DropdownMenuItem variant="destructive" onClick={onDelete}>
          {m.records_delete_week()}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
    <Button type="button" variant="ghost" size="icon" className="md:hidden" onClick={back}>
      <span className="sr-only">{m.controls_back()}</span>
      <ChevronLeft aria-hidden="true" className="size-4" />
    </Button>
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
