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
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { ButtonGroup, ButtonGroupItem } from "@/components/base/button-group/button-group";
import { Dropdown } from "@/components/base/dropdown/dropdown";
import { Input } from "@/components/base/input/input";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { avatarInitial, avatarToneClassName } from "@/lib/avatar-tone";
import { cx } from "@/utils/cx";
import { m } from "@/paraglide/messages";
import {
  addCurrentWeeklyCycle,
  deleteWeeklyCycle,
  type loadRecordsCatalog,
} from "./records.functions";

export type RecordsTab = "weekly" | "notes";
export type RecordsPanel = "settings" | "stats";
export type RecordsCatalog = Awaited<ReturnType<typeof loadRecordsCatalog>>;
type ToolbarKey = RecordsTab | RecordsPanel;

function recordsTabSearch(tab: string | undefined): RecordsTab {
  return tab === "notes" ? "notes" : "weekly";
}

function reportStatusColor(status: string): "gray" | "success" | "blue" {
  if (status === "submitted") return "success";
  if (status === "shared") return "blue";
  return "gray";
}

function reportStatusLabel(status: string): string {
  if (status === "submitted") return m.records_status_submitted();
  if (status === "shared") return m.records_status_shared();
  return m.records_status_draft();
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
  const toolbarKey: ToolbarKey = selectedPanel ?? tab;

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

  function selectToolbar(next: string) {
    if (next === "settings") {
      setShowMobileList(false);
      void navigate({
        to: "/records/settings",
        search: (previous) => ({ tab: recordsTabSearch(previous.tab) }),
      });
      return;
    }
    if (next === "stats") {
      setShowMobileList(false);
      const now = new Date();
      void navigate({
        to: "/records/stats",
        search: (previous) => ({
          tab: recordsTabSearch(previous.tab),
          year: typeof previous.year === "number" ? previous.year : now.getFullYear(),
          month: typeof previous.month === "number" ? previous.month : now.getMonth() + 1,
        }),
      });
      return;
    }
    const nextTab = recordsTabSearch(next);
    if (selectedPanel) {
      void navigate({ to: "/records", search: { tab: nextTab } });
      return;
    }
    onTabChange(nextTab);
  }

  return (
    <main className="flex h-svh min-w-0">
      <nav
        aria-label={m.records_list_label()}
        className={cx(
          "min-w-0 flex-col overflow-hidden bg-primary md:flex md:w-80 md:shrink-0 md:border-r md:border-secondary",
          listHidden ? "hidden" : "flex w-full",
        )}
      >
        <PageHeader
          heading={m.records_title()}
          actions={
            selectedPanel === "settings" ? undefined : (
              <Button
                size="sm"
                color="secondary"
                iconLeading={Plus}
                onPress={() => {
                  setShowMobileList(false);
                  void navigate({
                    to: "/records/settings",
                    search: (previous) => ({ tab: recordsTabSearch(previous.tab), create: true }),
                  });
                }}
              >
                {m.records_create_template()}
              </Button>
            )
          }
        />

        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-secondary px-3">
          <ButtonGroup
            aria-label={m.records_list_label()}
            size="sm"
            selectedKeys={[toolbarKey]}
            disallowEmptySelection
            onSelectionChange={(keys) => {
              const next = [...keys][0];
              if (next !== undefined) selectToolbar(String(next));
            }}
          >
            <ButtonGroupItem id="weekly" iconLeading={FileText}>
              {m.records_tab_weekly()}
            </ButtonGroupItem>
            <ButtonGroupItem id="notes" iconLeading={Edit}>
              {m.records_tab_notes()}
            </ButtonGroupItem>
            <ButtonGroupItem id="stats" iconLeading={LineChart}>
              {m.records_stats()}
            </ButtonGroupItem>
            <ButtonGroupItem id="settings" iconLeading={Settings}>
              {m.records_settings()}
            </ButtonGroupItem>
          </ButtonGroup>
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="px-3 pt-3">
            <Input
              size="sm"
              type="search"
              icon={Search}
              value={query}
              onChange={setQuery}
              placeholder={m.records_search_placeholder()}
            />
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
                    <ul className="divide-y divide-secondary">
                      {filteredFavorites.map((item) => (
                        <li key={item.id}>
                          <RecordRow
                            recordId={item.id}
                            selected={item.id === selectedRecordId}
                            onSelect={() => setShowMobileList(false)}
                            leading={
                              <Avatar
                                size="xs"
                                alt={item.author.displayName}
                                initials={avatarInitial(item.author.displayName)}
                                contentClassName={avatarToneClassName(item.author.displayName)}
                              />
                            }
                            title={item.title}
                            meta={item.author.displayName}
                          />
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
                    <ul className="divide-y divide-secondary">
                      {filteredHighlights.map((item) => (
                        <li key={item.id}>
                          <RecordRow
                            recordId={item.id}
                            selected={item.id === selectedRecordId}
                            onSelect={() => setShowMobileList(false)}
                            leading={<WeekChip week={item.week} />}
                            title={item.title}
                          />
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
                    <ul className="divide-y divide-secondary">
                      {filteredMyReports.map((item) => (
                        <li key={item.id}>
                          <RecordRow
                            recordId={item.id}
                            selected={item.id === selectedRecordId}
                            onSelect={() => setShowMobileList(false)}
                            leading={<WeekChip week={item.week} />}
                            title={item.title}
                            status={item.status}
                          />
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
                      size="xs"
                      color="tertiary"
                      icon={Plus}
                      isDisabled={busy}
                      aria-label={m.records_add_member_week()}
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
                          <li key={week.id}>
                            <div className="flex min-w-0 items-center gap-1">
                              <ButtonUtility
                                size="xs"
                                color="tertiary"
                                className="shrink-0"
                                icon={
                                  <ChevronDown
                                    aria-hidden="true"
                                    className={cx(
                                      "size-4 transition-transform",
                                      expanded && "rotate-180",
                                    )}
                                  />
                                }
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
                                <RecordRow
                                  recordId={(week.templateReport?.id ?? week.highlight?.id)!}
                                  selected={
                                    week.templateReport?.id === selectedRecordId ||
                                    week.highlight?.id === selectedRecordId
                                  }
                                  onSelect={() => setShowMobileList(false)}
                                  title={week.title}
                                  trailing={
                                    week.latestTemplate ? (
                                      <Badge size="sm" color="brand">
                                        {m.records_latest_template()}
                                      </Badge>
                                    ) : null
                                  }
                                  className="min-w-0 flex-1"
                                />
                              ) : (
                                <div className="flex min-h-12 min-w-0 flex-1 items-center px-2.5 py-2 text-sm">
                                  <span className="truncate font-medium text-primary">
                                    {week.title}
                                  </span>
                                </div>
                              )}
                              <WeekActionsMenu
                                weekTitle={week.title}
                                onDelete={() => void onDeleteCycle(week.id)}
                              />
                            </div>
                            {expanded && (
                              <ul className="ml-7 divide-y divide-secondary">
                                {week.reports.map((report) => (
                                  <li key={report.id}>
                                    <RecordRow
                                      recordId={report.id}
                                      selected={report.id === selectedRecordId}
                                      onSelect={() => setShowMobileList(false)}
                                      leading={
                                        <Avatar
                                          size="xs"
                                          alt={report.author.displayName}
                                          initials={avatarInitial(report.author.displayName)}
                                          contentClassName={avatarToneClassName(
                                            report.author.displayName,
                                          )}
                                        />
                                      }
                                      title={report.title}
                                      status={report.status}
                                    />
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
              <p className="px-1 py-6 text-sm text-tertiary">{m.records_notes_empty()}</p>
            ) : (
              <ul className="divide-y divide-secondary">
                {filteredNotes.map((note) => (
                  <li key={note.id} className="px-2.5 py-2 text-sm">
                    <div className="font-medium text-primary">{note.title}</div>
                    <div className="text-xs text-tertiary">{note.preview}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </nav>

      <section
        className={cx(
          "min-w-0 flex-1 flex-col overflow-hidden bg-primary md:flex",
          listHidden ? "flex" : "hidden",
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
  return <p className="px-1 py-2 text-xs text-tertiary">{m.records_section_empty()}</p>;
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
          color="tertiary"
          size="xs"
          iconLeading={
            <ChevronDown
              aria-hidden="true"
              className={cx("size-3.5 transition-transform", open && "rotate-180")}
            />
          }
          aria-expanded={open}
          onPress={() => onOpenChange(!open)}
          className="min-w-0 flex-1 justify-start gap-1 px-1 py-1 text-xs font-semibold text-tertiary uppercase"
        >
          <span className="truncate normal-case">{title}</span>
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
        size="xs"
        color="tertiary"
        className="shrink-0"
        icon={DotsHorizontal}
        aria-label={`${m.records_week_actions()}: ${weekTitle}`}
      />
      <Dropdown.Popover placement="bottom end" className="w-36">
        <Dropdown.Menu
          onAction={(key) => {
            if (key === "delete") onDelete();
          }}
        >
          <Dropdown.Item id="delete" label={m.records_delete_week()} />
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}

function RecordRow({
  recordId,
  selected,
  onSelect,
  leading,
  title,
  meta,
  status,
  trailing,
  className,
}: {
  recordId: string;
  selected: boolean;
  onSelect: () => void;
  leading?: ReactNode;
  title: string;
  meta?: string;
  status?: string;
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <Link
      to="/records/$recordId"
      params={{ recordId }}
      search={(previous) => ({ tab: recordsTabSearch(previous.tab) })}
      aria-current={selected ? "page" : undefined}
      resetScroll={false}
      onClick={onSelect}
      className={cx(
        "flex min-h-12 min-w-0 items-center gap-2.5 rounded-md px-2.5 py-2 text-sm outline-none transition-colors hover:bg-primary_hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand aria-[current=page]:bg-secondary",
        className,
      )}
    >
      {leading}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-primary">{title}</span>
        {meta && <span className="block truncate text-xs text-tertiary">{meta}</span>}
      </span>
      {status && (
        <Badge size="sm" color={reportStatusColor(status)}>
          {reportStatusLabel(status)}
        </Badge>
      )}
      {trailing}
    </Link>
  );
}

function WeekChip({ week }: { week: number }) {
  return (
    <Badge type="pill-color" size="sm" color="gray" className="shrink-0">
      W{week}
    </Badge>
  );
}

export function BackToRecords() {
  const back = useContext(BackToRecordsContext);
  if (!back) return null;
  return (
    <ButtonUtility
      size="sm"
      color="tertiary"
      className="-ml-2 size-11 md:hidden"
      onClick={back}
      aria-label={m.controls_back()}
      icon={ChevronLeft}
    />
  );
}

export function EmptyRecord() {
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyTitle>{m.records_empty_title()}</EmptyTitle>
        <EmptyDescription>{m.records_empty_description()}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
