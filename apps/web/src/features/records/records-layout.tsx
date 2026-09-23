import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  ChevronDown,
  ChevronLeft,
  Edit01 as Edit,
  File02 as FileText,
  LineChartUp01 as LineChart,
  Plus,
  SearchLg as Search,
  Settings01 as Settings,
  XClose as X,
} from "@untitledui/icons";

import { PageHeader } from "#src/components/layout/page-header";
import { Tab, TabList, TabPanel, Tabs } from "#src/components/application/tabs/tabs";
import { Avatar } from "#src/components/base/avatar/avatar";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { Input } from "#src/components/base/input/input";
import { avatarInitial, avatarToneClassName } from "#src/lib/avatar-tone";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { createRecordNote, type loadRecordsCatalog } from "./records.functions";
import { sidebarPreview } from "./records-sidebar";
import {
  formatSendWindowCountdown,
  isWeeklySendArmed,
  weeklySendWindow,
} from "./weekly-send-window";

export type RecordsTab = "weekly" | "notes";
export type RecordsPanel = "settings" | "stats";
export type RecordsCatalog = Awaited<ReturnType<typeof loadRecordsCatalog>>;

function recordsTabSearch(tab: string | undefined): RecordsTab {
  return tab === "notes" ? "notes" : "weekly";
}

const BackToRecordsContext = createContext<(() => void) | undefined>(undefined);

const FormatEditHintContext = createContext<(editing: boolean) => void>(() => {});

export function useFormatEditHint() {
  return useContext(FormatEditHintContext);
}

function matchesQuery(text: string, query: string) {
  if (!query) return true;
  return text.toLowerCase().includes(query.toLowerCase());
}

export function RecordsLayout({
  catalog,
  selectedRecordId,
  selectedWeekKey,
  selectedPanel,
  tab,
  onTabChange,
  children,
  detailOpen,
}: {
  catalog: RecordsCatalog;
  selectedRecordId?: string;
  /** `year-week` key when the week empty route (or landing) is active. */
  selectedWeekKey?: string;
  /** True only when the URL is a record or panel — keeps the mobile list on `/records`. */
  detailOpen?: boolean;
  selectedPanel?: RecordsPanel | null;
  tab: RecordsTab;
  onTabChange: (tab: RecordsTab) => void;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const router = useRouter();
  const createNote = useServerFn(createRecordNote);
  const recordOpen = detailOpen ?? Boolean(selectedRecordId || selectedPanel || selectedWeekKey);
  const [showMobileList, setShowMobileList] = useState(!recordOpen);
  const [query, setQuery] = useState("");
  const [favoritesOpen, setFavoritesOpen] = useState(true);
  const [favoritesExpanded, setFavoritesExpanded] = useState(false);
  const [membersExpanded, setMembersExpanded] = useState(false);
  const [formatEditing, setFormatEditing] = useState(false);
  const [settingsHintDismissed, setSettingsHintDismissed] = useState(false);
  const [myReportsOpen, setMyReportsOpen] = useState(true);
  const [membersOpen, setMembersOpen] = useState(true);
  const [notesOpen, setNotesOpen] = useState(true);
  const [expandedWeeks, setExpandedWeeks] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const listHidden = recordOpen && !showMobileList;

  useEffect(() => {
    if (!formatEditing) setSettingsHintDismissed(false);
  }, [formatEditing]);

  const filteredFavorites = useMemo(
    () => catalog.favorites.filter((item) => matchesQuery(item.title, query)),
    [catalog.favorites, query],
  );
  const previewFavorites = useMemo(
    () => sidebarPreview(filteredFavorites, Boolean(query) || favoritesExpanded),
    [filteredFavorites, query, favoritesExpanded],
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
          key: `${week.year}-${week.week}`,
          submissions: week.submissions.filter(
            (submission) =>
              matchesQuery(submission.title, query) ||
              matchesQuery(submission.author.displayName, query) ||
              matchesQuery(week.title, query),
          ),
        }))
        .filter((week) => {
          if (!query) return true;
          return matchesQuery(week.title, query) || week.submissions.length > 0;
        }),
    [catalog.memberWeeks, query],
  );
  const previewMemberWeeks = useMemo(
    () => sidebarPreview(filteredMemberWeeks, Boolean(query) || membersExpanded),
    [filteredMemberWeeks, query, membersExpanded],
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

  async function onCreateNote() {
    if (busy) return;
    setBusy(true);
    try {
      const result = await createNote({ data: { title: m.records_note_untitled() } });
      setNotesOpen(true);
      void openCreatedRecord(result.id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormatEditHintContext value={setFormatEditing}>
      <main className="flex h-svh min-w-0 bg-primary">
        <nav
          aria-label={m.records_list_label()}
          className={cn(
            "min-w-0 flex-col overflow-hidden border-secondary bg-primary md:flex md:w-72 md:shrink-0 md:border-r xl:w-80",
            listHidden ? "hidden" : "flex w-full",
          )}
        >
          <PageHeader heading={m.records_title()} />
          <Tabs
            selectedKey={tab}
            onSelectionChange={(key) => {
              if (key === "weekly" || key === "notes") onTabChange(key);
            }}
            className="min-h-0 flex-1"
          >
            <div className="space-y-3 px-3 pt-3">
              <Input
                type="search"
                size="sm"
                icon={Search}
                aria-label={m.records_search_placeholder()}
                value={query}
                onChange={setQuery}
                placeholder={m.records_search_placeholder()}
              />
              <TabList aria-label={m.records_title()} type="underline" className="gap-4 px-1">
                <Tab id="weekly" icon={FileText}>
                  {m.records_tab_weekly()}
                </Tab>
                <Tab id="notes" icon={Edit}>
                  {m.records_tab_notes()}
                </Tab>
              </TabList>
            </div>

            <TabPanel id={tab} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
              {tab === "weekly" ? (
                <div className="space-y-5">
                  <div className="space-y-2">
                    {catalog.formatChips.map((chip) => (
                      <FormatChipSlot
                        key={chip.settingsId ?? `disabled-${chip.year}-${chip.week}`}
                        chip={chip}
                        distinguishSettingsName={
                          catalog.formatChips.filter((row) => row.interactive).length > 1
                        }
                        selected={Boolean(
                          chip.interactive && chip.id && chip.id === selectedRecordId,
                        )}
                        onSelect={() => setShowMobileList(false)}
                      />
                    ))}
                  </div>

                  <CollapsibleSection
                    title={m.records_section_favorites()}
                    open={favoritesOpen}
                    onOpenChange={setFavoritesOpen}
                  >
                    {filteredFavorites.length === 0 ? null : (
                      <ul className="space-y-0.5">
                        {previewFavorites.visible.map((item) => (
                          <li key={item.id}>
                            <RecordLink
                              recordId={item.id}
                              selected={item.id === selectedRecordId}
                              onSelect={() => setShowMobileList(false)}
                            >
                              <Avatar
                                size="sm"
                                alt={item.author.displayName}
                                src={item.author.avatarUrl ?? undefined}
                                initials={avatarInitial(item.author.displayName)}
                                contentClassName={avatarToneClassName(item.author.displayName)}
                              />
                              <span className="truncate">{item.title}</span>
                            </RecordLink>
                          </li>
                        ))}
                      </ul>
                    )}
                    <SidebarMore
                      hiddenCount={previewFavorites.hiddenCount}
                      onExpand={() => setFavoritesExpanded(true)}
                    />
                  </CollapsibleSection>

                  <CollapsibleSection
                    title={m.records_section_mine()}
                    open={myReportsOpen}
                    onOpenChange={setMyReportsOpen}
                  >
                    {filteredMyReports.length === 0 ? null : (
                      <ul className="space-y-0.5">
                        {filteredMyReports.map((item) => {
                          const unread = item.unread;
                          const sent = item.status === "submitted" || item.status === "shared";
                          return (
                            <li key={item.id}>
                              <RecordLink
                                recordId={item.id}
                                selected={item.id === selectedRecordId}
                                onSelect={() => setShowMobileList(false)}
                                className={cn(unread && "bg-brand-primary_alt font-semibold")}
                              >
                                <WeekBadge week={item.week} />
                                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                                {sent ? (
                                  <span className="ml-auto shrink-0 rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-tertiary">
                                    {m.records_report_sent_badge()}
                                  </span>
                                ) : unread ? (
                                  <span
                                    aria-label={m.records_report_unread_badge()}
                                    className="ml-auto size-1.5 shrink-0 rounded-full bg-brand-solid"
                                  />
                                ) : null}
                              </RecordLink>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </CollapsibleSection>

                  <CollapsibleSection
                    title={m.records_section_members()}
                    open={membersOpen}
                    onOpenChange={setMembersOpen}
                  >
                    {filteredMemberWeeks.length === 0 ? null : (
                      <ul className="space-y-1">
                        {previewMemberWeeks.visible.map((week) => {
                          const hasSubmissions = week.submissions.length > 0;
                          const weekSelected =
                            selectedWeekKey === week.key ||
                            week.overviewReportId === selectedRecordId ||
                            week.submissions.some((item) => item.id === selectedRecordId);
                          const expanded =
                            expandedWeeks[week.key] ??
                            ((Boolean(query) && hasSubmissions) || weekSelected);
                          return (
                            <li key={week.key} className="space-y-0.5">
                              <div className="flex min-w-0 items-center gap-1 rounded-lg">
                                {hasSubmissions ? (
                                  <ButtonUtility
                                    size="xs"
                                    color="tertiary"
                                    icon={
                                      <ChevronDown
                                        aria-hidden="true"
                                        data-icon
                                        className={cn(
                                          "size-4 transition-transform",
                                          expanded && "rotate-180",
                                        )}
                                      />
                                    }
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
                                        [week.key]: !expanded,
                                      }))
                                    }
                                  />
                                ) : (
                                  <span className="size-7 shrink-0" aria-hidden="true" />
                                )}
                                <RecordLink
                                  recordId={week.overviewReportId}
                                  selected={weekSelected}
                                  onSelect={() => setShowMobileList(false)}
                                  className="min-w-0 flex-1 font-medium"
                                >
                                  <WeekBadge week={week.week} />
                                  <span className="truncate">{week.title}</span>
                                </RecordLink>
                              </div>
                              {hasSubmissions && expanded ? (
                                <ul className="ml-7 space-y-0.5">
                                  {week.submissions.map((submission) => (
                                    <li key={submission.id}>
                                      <RecordLink
                                        recordId={submission.id}
                                        selected={submission.id === selectedRecordId}
                                        onSelect={() => setShowMobileList(false)}
                                      >
                                        <Avatar
                                          size="sm"
                                          alt={submission.author.displayName}
                                          src={submission.author.avatarUrl ?? undefined}
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
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    <SidebarMore
                      hiddenCount={previewMemberWeeks.hiddenCount}
                      onExpand={() => setMembersExpanded(true)}
                    />
                  </CollapsibleSection>
                </div>
              ) : (
                <CollapsibleSection
                  title={m.records_notes_mine()}
                  open={notesOpen}
                  onOpenChange={setNotesOpen}
                  actions={
                    <ButtonUtility
                      size="sm"
                      color="tertiary"
                      icon={Plus}
                      aria-label={m.records_add_note()}
                      isDisabled={busy}
                      onClick={() => void onCreateNote()}
                    />
                  }
                >
                  {filteredNotes.length === 0 ? (
                    <p className="px-1 py-4 text-sm text-tertiary">{m.records_notes_empty()}</p>
                  ) : (
                    <ul className="space-y-0.5">
                      {filteredNotes.map((note) => (
                        <li key={note.id}>
                          <RecordLink
                            recordId={note.id}
                            selected={note.id === selectedRecordId}
                            onSelect={() => setShowMobileList(false)}
                          >
                            <Avatar
                              size="sm"
                              alt={catalog.actorDisplayName}
                              src={catalog.actorAvatarUrl ?? undefined}
                              initials={avatarInitial(catalog.actorDisplayName)}
                              contentClassName={avatarToneClassName(catalog.actorDisplayName)}
                            />
                            <span className="truncate">{note.title}</span>
                          </RecordLink>
                        </li>
                      ))}
                    </ul>
                  )}
                </CollapsibleSection>
              )}
            </TabPanel>

            <div className="relative border-t border-secondary px-2 py-2">
              {formatEditing && !settingsHintDismissed ? (
                <div className="absolute bottom-full left-2 z-20 mb-2 w-60 rounded-xl border border-brand bg-brand-primary px-3 py-2 text-xs text-brand-secondary shadow-sm">
                  <div className="flex items-start gap-2">
                    <p className="min-w-0 flex-1">
                      {m.records_format_settings_hint()}{" "}
                      <Link
                        to="/records/settings"
                        search={(previous) => ({ tab: recordsTabSearch(previous.tab) })}
                        className="font-medium underline"
                      >
                        {m.records_settings()}
                      </Link>
                    </p>
                    <ButtonUtility
                      size="xs"
                      color="tertiary"
                      icon={X}
                      tooltip={m.records_format_settings_hint_dismiss()}
                      aria-label={m.records_format_settings_hint_dismiss()}
                      onClick={() => setSettingsHintDismissed(true)}
                      className="size-5 shrink-0"
                    />
                  </div>
                </div>
              ) : null}
              <Dropdown.Root>
                <ButtonUtility
                  size="sm"
                  color="tertiary"
                  icon={Settings}
                  aria-label={m.records_tools_menu()}
                />
                <Dropdown.Popover placement="top start" className="w-52">
                  <Dropdown.Menu
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
                      }
                      if (key === "settings") {
                        setShowMobileList(false);
                        void navigate({
                          to: "/records/settings",
                          search: (previous) => ({
                            tab: recordsTabSearch(previous.tab),
                          }),
                        });
                      }
                    }}
                  >
                    <Dropdown.Item id="stats" icon={LineChart} label={m.records_stats()} />
                    <Dropdown.Item id="settings" icon={Settings} label={m.records_settings()} />
                  </Dropdown.Menu>
                </Dropdown.Popover>
              </Dropdown.Root>
            </div>
          </Tabs>
        </nav>

        <section
          className={cn(
            "min-w-0 flex-1 flex-col overflow-hidden bg-primary md:flex",
            listHidden ? "flex" : "hidden md:flex",
          )}
        >
          <BackToRecordsContext value={() => setShowMobileList(true)}>
            {children}
          </BackToRecordsContext>
        </section>
      </main>
    </FormatEditHintContext>
  );
}

function FormatChipSlot({
  chip,
  distinguishSettingsName,
  selected,
  onSelect,
}: {
  chip: RecordsCatalog["formatChips"][number];
  distinguishSettingsName: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const [now, setNow] = useState(() => new Date());
  const appliedSchedule = chip.appliedSchedule;
  const alreadySent = chip.alreadySent;

  useEffect(() => {
    if (!chip.interactive || !appliedSchedule || alreadySent) return;
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, [chip.interactive, appliedSchedule, alreadySent]);

  const sendArmed =
    chip.interactive && appliedSchedule
      ? isWeeklySendArmed({
          applied: true,
          alreadySent,
          sendWeekday: appliedSchedule.sendWeekday,
          sendTime: appliedSchedule.sendTime,
          scheduleEnabled: appliedSchedule.scheduleEnabled,
          autoSendCancelled: chip.autoSendCancelled,
          now,
        })
      : false;

  const windowRange =
    sendArmed && appliedSchedule
      ? weeklySendWindow({
          now,
          sendWeekday: appliedSchedule.sendWeekday,
          sendTime: appliedSchedule.sendTime,
          scheduleEnabled: appliedSchedule.scheduleEnabled,
        })
      : null;
  const remainingMs = windowRange ? Math.max(0, windowRange.end.getTime() - now.getTime()) : 0;

  const weekLabel = m.records_current_week_template({
    year: chip.year,
    week: chip.week,
  });
  const chipTitle =
    distinguishSettingsName && chip.name.trim() && chip.name.trim() !== weekLabel
      ? `${weekLabel} · ${chip.name.trim()}`
      : weekLabel;

  const label = (
    <>
      <span className="truncate">{chipTitle}</span>
      {alreadySent ? (
        <span className="ml-auto shrink-0 rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-tertiary">
          {m.records_report_sent_badge()}
        </span>
      ) : sendArmed ? (
        <span className="shrink-0 tabular-nums">{formatSendWindowCountdown(remainingMs)}</span>
      ) : null}
    </>
  );

  const chipClassName = cn(
    "flex min-h-10 w-full items-center justify-center gap-2 rounded-full px-3 py-2 text-sm font-medium transition-colors",
    sendArmed ? "bg-brand-primary text-brand-secondary" : "bg-secondary text-tertiary",
    chip.interactive && !sendArmed && "hover:bg-secondary_hover",
    !chip.interactive && "cursor-not-allowed opacity-60",
    selected && sendArmed && "ring-1 ring-brand",
  );

  if (!chip.interactive || !chip.id) {
    return (
      <div
        role="status"
        aria-disabled="true"
        aria-label={m.records_current_week_template_disabled()}
        className={chipClassName}
      >
        {label}
      </div>
    );
  }

  return (
    <Link
      to="/records/$recordId"
      params={{ recordId: chip.id }}
      search={(previous) => ({ tab: recordsTabSearch(previous.tab) })}
      aria-current={selected ? "page" : undefined}
      resetScroll={false}
      onClick={onSelect}
      className={cn(
        chipClassName,
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
      )}
    >
      {label}
    </Link>
  );
}

function SidebarMore({ hiddenCount, onExpand }: { hiddenCount: number; onExpand: () => void }) {
  if (hiddenCount <= 0) return null;
  return (
    <Button
      type="button"
      size="xs"
      color="tertiary"
      onPress={onExpand}
      className="mt-0.5 w-full justify-start px-2.5 text-xs text-tertiary"
    >
      {m.records_sidebar_more({ count: hiddenCount })}
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
          size="sm"
          color="tertiary"
          aria-expanded={open}
          onPress={() => onOpenChange(!open)}
          iconLeading={
            <ChevronDown
              aria-hidden="true"
              className={cn("size-4 transition-transform", open && "rotate-180")}
            />
          }
          className="min-w-0 flex-1 justify-start px-1 text-left text-sm text-primary"
        >
          {title}
        </Button>
        {actions}
      </div>
      {open && children}
    </section>
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
        "flex min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-primary transition-colors hover:bg-primary_hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
        selected && "bg-primary_hover font-medium",
        className,
      )}
    >
      {children}
    </Link>
  );
}

export function WeekBadge({ week }: { week: number }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary-solid text-xs font-semibold text-white"
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
      size="sm"
      color="tertiary"
      icon={ChevronLeft}
      className="md:hidden"
      aria-label={m.controls_back()}
      onClick={back}
    />
  );
}

/** Back control when arriving from a key-point `@source` link (`?returnTo=`). */
export function RecordsKeyPointReturnBack({ returnTo }: { returnTo: string }) {
  const router = useRouter();
  return (
    <Button
      size="sm"
      color="link-color"
      iconLeading={ChevronLeft}
      onPress={() => {
        void router.navigate({ href: returnTo });
      }}
    >
      {m.records_key_points_back_to_report()}
    </Button>
  );
}

export function EmptyRecord() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <p className="text-base font-semibold text-primary">{m.records_empty_title()}</p>
    </div>
  );
}
