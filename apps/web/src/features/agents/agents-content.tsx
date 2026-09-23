import { useEffect, useState } from "react";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { GridList, GridListItem, GridListLoadMoreItem, ProgressBar } from "react-aria-components";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useBreakpoint } from "@/hooks/use-breakpoint";
import {
  Calendar,
  DotsVertical,
  Eye,
  Loading02,
  Monitor01 as Monitor,
  Plus,
  SearchLg as Search,
  Trash01,
  Users01 as UsersRound,
  UsersPlus,
} from "@untitledui/icons";

import { Tab, TabList, TabPanel, Tabs } from "@/components/application/tabs/tabs";
import { ButtonGroup, ButtonGroupItem } from "@/components/base/button-group/button-group";
import { Dropdown } from "@/components/base/dropdown/dropdown";
import { Select } from "@/components/base/select/select";
import { MobileNavigationButton } from "@/components/layout/sidebar/mobile-header";
import { formatCalendarDate } from "@/lib/dates";
import { Avatar } from "@/components/base/avatar/avatar";
import { avatarInitial, avatarToneClassName } from "@/lib/avatar-tone";
import { getLocale, localizeHref } from "@/paraglide/runtime";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";
import { InviteMemberDialog } from "@/features/workspaces/invite-member-dialog";
import { conversationLayoutStorage } from "@/features/conversations/layout-storage";
import type { AgentStatusView } from "./agent-status-realtime";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import { AgentDisplayAvatar } from "./agent-activity-avatar";
import { AgentCreateDialog } from "./agent-create-dialog";
import { AgentDeleteDialog } from "./agent-delete-dialog";
import type { RuntimeCatalog } from "./agent-runtime-fields";
import type { CreateAgentInput } from "./agent.schemas";
import type {
  MemberAgent,
  MemberDirectorySummary,
  MemberPerson,
} from "@/features/workspaces/workspaces.functions";
import { NO_COMPUTER } from "@/features/workspaces/member-directory";
import { memberAgentsQuery, memberPeopleQuery } from "./member-directory-queries";
import { AgentProfilePanel } from "./profile-panel/agent-profile-panel";
import { useOpenAgentProfile } from "./profile-panel/open-agent-profile";
import {
  formatAgentProfileParam,
  type AgentProfileTab,
} from "./profile-panel/profile-panel-search";

type ComputerOption = {
  id: string;
  name: string;
  displayName: string;
  online?: boolean;
  runtimes: { provider: string }[];
};

const appRoute = getRouteApi("/_app");

export type AgentView = {
  id: string;
  name: string;
  displayName: string;
  description?: string;
  status: AgentStatusView;
  display?: AgentDisplaySnapshot;
};

export type MemberTab = "agent" | "human";
export type OwnerFilter = "all" | "mine";

export function AgentsContent({
  summary,
  memberType,
  owner,
  computer,
  onFiltersChange,
  agents,
  computers,
  profileAgentId,
  agentTab,
  onCreate,
  onLoadRuntimeCatalog,
  onInviteMember,
  onDeleteAgent,
  defaultCreateDialogOpen = false,
}: {
  summary: MemberDirectorySummary;
  memberType: MemberTab;
  owner: OwnerFilter;
  /** A Computer id, `"none"`, or undefined for every Computer. */
  computer?: string;
  onFiltersChange: (filters: {
    memberType?: MemberTab;
    owner?: OwnerFilter;
    computer?: string | undefined;
  }) => void;
  agents: AgentView[];
  computers: ComputerOption[];
  profileAgentId?: string;
  agentTab?: AgentProfileTab;
  onCreate: (input: CreateAgentInput) => Promise<{ startPublished: boolean }>;
  onLoadRuntimeCatalog: (computerId: string) => Promise<RuntimeCatalog[]>;
  onInviteMember: (input: { username: string; role: "admin" | "member" }) => Promise<void>;
  onDeleteAgent: (agentId: string, confirmation: string) => Promise<void>;
  defaultCreateDialogOpen?: boolean;
}) {
  const { setAgentProfileTab, closeAgentProfile } = useOpenAgentProfile();
  const timeZone = appRoute.useLoaderData().timeZone;
  const locale = getLocale();
  const [search, setSearch] = useState("");
  // The server searches; wait for a pause in typing instead of fetching on every keystroke.
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);
  const [open, setOpen] = useState(defaultCreateDialogOpen);
  const [inviteOpen, setInviteOpen] = useState(false);
  // The target outlives `deleteOpen` so the dialog keeps its title through the close animation.
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deferredStart, setDeferredStart] = useState(false);
  const canInviteMember = summary.actorRole === "owner" || summary.actorRole === "admin";
  // Agent creation requires Workspace owner/admin; see ManageAgents.create / assertCanCreateAgents.
  const canCreateAgent = canInviteMember;
  // Deletion is the same owner/admin capability (ADR 0044), and only for Agents the directory marks
  // deletable; the server re-checks both.
  const canDeleteAgent = canInviteMember;
  const onAgentTab = memberType === "agent";
  const tabTotal = onAgentTab ? summary.agentCount : summary.peopleCount;
  const ownedAgents = new Map(agents.map((agent) => [agent.id, agent]));
  const computerOptions = [
    ...summary.computers.map((option) => ({
      id: option.id,
      label: option.name || m.agent_computer_unnamed(),
    })),
    ...(summary.hasAgentWithoutComputer
      ? [{ id: NO_COMPUTER, label: m.member_no_computer() }]
      : []),
  ];
  const filtersActive = onAgentTab && (owner === "mine" || computer !== undefined);
  // Keep the cards already on screen while a changed filter or search loads its first page.
  const agentPages = useInfiniteQuery({
    ...memberAgentsQuery(summary.workspaceId, { owner, computer, query }),
    enabled: onAgentTab,
    placeholderData: keepPreviousData,
  });
  const peoplePages = useInfiniteQuery({
    ...memberPeopleQuery(summary.workspaceId, query),
    enabled: !onAgentTab,
    placeholderData: keepPreviousData,
  });
  const pages = onAgentTab ? agentPages : peoplePages;
  const listedAgents = onAgentTab
    ? (agentPages.data?.pages.flatMap((page) => page.items) ?? [])
    : [];
  const listedPeople = onAgentTab
    ? []
    : (peoplePages.data?.pages.flatMap((page) => page.items) ?? []);
  const loadMore = () => {
    if (pages.hasNextPage && !pages.isFetchingNextPage) void pages.fetchNextPage();
  };
  const profileOpen = Boolean(profileAgentId);
  // `useBreakpoint` is true during SSR. Stay stacked until after mount so a phone never
  // first-paints the profile as a 35% column with a blank left side.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const desktop = useBreakpoint("md");
  const splitOpen = mounted && desktop && profileOpen;
  const membersLayout = useDefaultLayout({
    id: "coforge-members",
    panelIds: splitOpen ? ["main", "profile"] : ["main"],
    onlySaveAfterUserInteractions: true,
    storage: conversationLayoutStorage,
  });

  const profile =
    profileOpen && profileAgentId ? (
      <AgentProfilePanel
        agentId={profileAgentId}
        requestedTab={agentTab}
        onTabChange={setAgentProfileTab}
        onClose={closeAgentProfile}
      />
    ) : null;

  const directoryPane = (
    <Tabs
      selectedKey={memberType}
      onSelectionChange={(key) => {
        if (key === "agent" || key === "human") onFiltersChange({ memberType: key });
      }}
      className="@container/members min-h-0 min-w-0 flex-1"
    >
      {/* One row with centred tabs once the pane (not the viewport) is wide enough; narrower, as
       * on a phone or beside the profile panel, the tabs wrap onto their own row. */}
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 border-b border-secondary px-4 sm:px-6 @2xl/members:grid @2xl/members:h-12 @2xl/members:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <div className="flex h-12 min-w-0 flex-1 items-center gap-3">
          <MobileNavigationButton />
          <h1 className="truncate text-lg font-semibold text-primary">{m.navigation_agents()}</h1>
        </div>
        <div className="order-last flex basis-full self-end @2xl/members:order-none @2xl/members:basis-auto">
          <TabList
            aria-label={m.member_type_filter()}
            type="underline"
            className="gap-6 before:hidden"
          >
            <Tab id="agent">{m.member_tab_agents_count({ count: summary.agentCount })}</Tab>
            <Tab id="human">{m.member_tab_humans_count({ count: summary.peopleCount })}</Tab>
          </TabList>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2 @2xl/members:justify-self-end">
          {onAgentTab
            ? canCreateAgent && (
                <Button size="sm" color="primary" iconLeading={Plus} onPress={() => setOpen(true)}>
                  {m.header_new_agent()}
                </Button>
              )
            : canInviteMember && (
                <Button
                  size="sm"
                  color="primary"
                  iconLeading={UsersPlus}
                  onPress={() => setInviteOpen(true)}
                >
                  {m.workspace_invite_button()}
                </Button>
              )}
        </div>
      </header>
      {tabTotal > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-3 px-4 pt-5 sm:px-6">
          {onAgentTab && (
            <>
              <ButtonGroup
                aria-label={m.member_owner_filter()}
                size="sm"
                selectionMode="single"
                disallowEmptySelection
                selectedKeys={[owner]}
                onSelectionChange={(keys) => {
                  const [next] = [...keys];
                  if (next === "all" || next === "mine") onFiltersChange({ owner: next });
                }}
              >
                <ButtonGroupItem id="mine">{m.filters_mine()}</ButtonGroupItem>
                <ButtonGroupItem id="all">{m.filters_all()}</ButtonGroupItem>
              </ButtonGroup>
              <Select
                aria-label={m.filters_computer()}
                size="sm"
                placeholder={m.filters_computer()}
                selectedKey={computer ?? null}
                onSelectionChange={(key) =>
                  onFiltersChange({
                    computer: key === ALL_COMPUTERS || key === null ? undefined : String(key),
                  })
                }
                className="w-44"
                popoverClassName="min-w-56"
              >
                {[{ id: ALL_COMPUTERS, label: m.member_all_computers() }, ...computerOptions].map(
                  (option) => (
                    <Select.Item key={option.id} id={option.id} label={option.label} />
                  ),
                )}
              </Select>
            </>
          )}
          <Input
            type="search"
            size="sm"
            icon={Search}
            aria-label={m.filters_search()}
            placeholder={`${m.filters_search()}...`}
            value={search}
            onChange={setSearch}
            className="w-full sm:w-80"
          />
        </div>
      )}
      <TabPanel id={memberType} className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 sm:px-6">
        {deferredStart && (
          <p
            role="status"
            className="mt-5 rounded-lg border border-secondary bg-secondary px-4 py-3 text-sm text-tertiary"
          >
            {m.agent_deferred_start_notice()}
          </p>
        )}
        {pages.isError && !pages.data ? (
          <div role="alert" className="mt-8 flex flex-col items-center gap-3 text-center">
            <p className="text-sm text-error-primary">{m.member_directory_load_error()}</p>
            <Button size="sm" color="secondary" onPress={() => void pages.refetch()}>
              {m.controls_retry()}
            </Button>
          </div>
        ) : pages.isPending ? null : listedPeople.length + listedAgents.length ? (
          <GridList
            aria-label={onAgentTab ? m.member_tab_agents() : m.member_tab_humans()}
            layout="grid"
            className="mt-4 grid gap-4 outline-none md:grid-cols-[repeat(auto-fill,minmax(18rem,1fr))]"
          >
            {listedPeople.map((person) => (
              <PersonCard key={person.id} person={person} />
            ))}
            {listedAgents.map((member) => (
              <AgentCard
                key={member.id}
                member={member}
                ownedAgent={ownedAgents.get(member.id)}
                selected={member.id === profileAgentId}
                // Without a time-zone preference the server and browser zones differ, so the date
                // is only formatted after mount (the same rule as RelativeTime).
                createdOn={
                  timeZone || mounted ? formatCalendarDate(member.createdAt, timeZone, locale) : ""
                }
                onDelete={
                  canDeleteAgent && member.deletable
                    ? () => {
                        setDeleteTarget({ id: member.id, name: member.name });
                        setDeleteOpen(true);
                      }
                    : undefined
                }
              />
            ))}
            {/* React Aria asks for the next page as this sentinel nears the scroll area's end. */}
            <GridListLoadMoreItem
              onLoadMore={loadMore}
              isLoading={pages.isFetchingNextPage}
              className="col-span-full flex justify-center py-4"
            >
              <ProgressBar
                isIndeterminate
                aria-label={m.member_loading_more()}
                className="text-fg-quaternary"
              >
                <Loading02 aria-hidden="true" className="size-5 motion-safe:animate-spin" />
              </ProgressBar>
            </GridListLoadMoreItem>
          </GridList>
        ) : null}
        {pages.isFetchNextPageError ? (
          // React Aria re-arms its sentinel only when the list changes, so a failed page needs an
          // explicit retry or the list would silently end early.
          <div role="alert" className="mt-4 flex flex-col items-center gap-3 text-center">
            <p className="text-sm text-error-primary">{m.member_directory_load_error()}</p>
            <Button size="sm" color="secondary" onPress={() => void pages.fetchNextPage()}>
              {m.controls_retry()}
            </Button>
          </div>
        ) : pages.isError || pages.isPending || listedPeople.length + listedAgents.length ? null : (
          <Empty
            className={
              tabTotal ? "gap-5 px-0 py-12" : "gap-6 px-0 pt-[clamp(3rem,12svh,7rem)] pb-10"
            }
          >
            <EmptyHeader className="max-w-xs gap-3">
              {tabTotal ? (
                <EmptyMedia>
                  <Search aria-hidden="true" className="size-8 text-tertiary" strokeWidth={1.5} />
                </EmptyMedia>
              ) : (
                <EmptyMedia aria-hidden="true" className="relative mb-3 h-28 w-44">
                  <span className="absolute inset-x-2 top-0 h-24 rounded-full bg-secondary" />
                  <UsersRound className="relative size-20 text-tertiary" strokeWidth={1} />
                  <span className="absolute right-2 bottom-0 flex size-10 items-center justify-center rounded-xl border border-secondary bg-primary text-tertiary shadow-sm">
                    <Plus className="size-5" />
                  </span>
                </EmptyMedia>
              )}
              <EmptyTitle role="heading" aria-level={2} className="text-lg font-semibold">
                {tabTotal
                  ? m.agent_no_search_results()
                  : onAgentTab
                    ? m.agent_empty_title()
                    : m.member_no_humans()}
              </EmptyTitle>
              <EmptyDescription>
                {tabTotal
                  ? filtersActive
                    ? m.member_filter_empty_description()
                    : m.agent_search_description()
                  : onAgentTab
                    ? m.agent_empty_description()
                    : null}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              {tabTotal ? (
                <Button
                  color="secondary"
                  onPress={() => {
                    setSearch("");
                    setQuery("");
                    if (filtersActive) onFiltersChange({ owner: "all", computer: undefined });
                  }}
                >
                  {filtersActive ? m.member_clear_filters() : m.agent_clear_search()}
                </Button>
              ) : null}
            </EmptyContent>
          </Empty>
        )}
      </TabPanel>
    </Tabs>
  );

  return (
    <main className="flex h-svh min-w-0 bg-primary">
      {splitOpen ? (
        <Group
          key="split"
          id="members"
          orientation="horizontal"
          defaultLayout={membersLayout.defaultLayout}
          onLayoutChanged={membersLayout.onLayoutChanged}
          className="flex min-h-0 min-w-0 flex-1"
        >
          <Panel id="main" minSize="40" className="flex min-h-0 min-w-0 flex-col">
            {directoryPane}
          </Panel>
          <Separator
            aria-label={m.agent_profile_resize()}
            className="w-px shrink-0 bg-border-secondary transition-colors hover:bg-brand-solid data-[separator=active]:bg-brand-solid"
          />
          <Panel
            id="profile"
            defaultSize="35"
            minSize="25"
            maxSize="60"
            className="flex min-h-0 min-w-0 flex-col"
          >
            {profile}
          </Panel>
        </Group>
      ) : profileOpen ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{profile}</div>
      ) : (
        directoryPane
      )}

      <InviteMemberDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onInvite={async (input) => {
          await onInviteMember(input);
        }}
      />

      <AgentCreateDialog
        open={open}
        onOpenChange={setOpen}
        computers={computers}
        onCreate={onCreate}
        onLoadRuntimeCatalog={onLoadRuntimeCatalog}
        onCreated={(result) => setDeferredStart(!result.startPublished)}
      />

      <AgentDeleteDialog
        key={deleteTarget?.id}
        agentName={deleteTarget?.name ?? ""}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDelete={async (confirmation) => {
          if (!deleteTarget) return;
          await onDeleteAgent(deleteTarget.id, confirmation);
          if (deleteTarget.id === profileAgentId) closeAgentProfile();
          setDeleteOpen(false);
        }}
      />
    </main>
  );
}

type DirectoryAgent = MemberAgent;
type DirectoryPerson = MemberPerson;

/** The Computer select's "every Computer" entry; never a real Computer id. */
const ALL_COMPUTERS = "all";

const SEARCH_DEBOUNCE_MS = 250;

const CARD_CLASS =
  "flex min-w-0 flex-col gap-2.5 rounded-xl bg-primary p-4 shadow-xs ring-1 ring-secondary outline-focus-ring ring-inset data-focus-visible:outline-2 data-focus-visible:outline-offset-2";

function PersonCard({ person }: { person: DirectoryPerson }) {
  return (
    <GridListItem id={person.id} textValue={person.displayName} className={CARD_CLASS}>
      <Avatar
        size="lg"
        alt={person.displayName}
        src={person.avatarUrl ?? undefined}
        initials={avatarInitial(person.displayName)}
        contentClassName={avatarToneClassName(person.displayName)}
      />
      <div className="min-w-0">
        <h2 className="truncate text-md font-semibold text-primary">{person.displayName}</h2>
        <p className="truncate text-sm text-tertiary">@{person.name}</p>
      </div>
      {person.description && (
        <p className="line-clamp-2 text-sm leading-5 break-words text-secondary">
          {person.description}
        </p>
      )}
    </GridListItem>
  );
}

function AgentCard({
  member,
  ownedAgent,
  selected,
  createdOn,
  onDelete,
}: {
  member: DirectoryAgent;
  ownedAgent?: AgentView;
  selected: boolean;
  createdOn: string;
  /** Present only for a viewer who may delete Agents. */
  onDelete?: () => void;
}) {
  const navigate = useNavigate();
  const openProfile = () =>
    void navigate({
      to: "/agents",
      resetScroll: false,
      search: (previous) => ({ ...previous, profile: formatAgentProfileParam(member.id) }),
    });

  return (
    <GridListItem
      id={member.id}
      textValue={member.displayName}
      className={cn(CARD_CLASS, selected && "ring-2 ring-brand")}
    >
      <div className="flex items-start justify-between gap-3">
        {ownedAgent ? (
          <AgentDisplayAvatar
            name={member.displayName}
            src={member.avatarUrl}
            display={ownedAgent.display}
            size="lg"
          />
        ) : (
          <Avatar
            size="lg"
            alt={member.displayName}
            src={member.avatarUrl ?? undefined}
            initials={avatarInitial(member.displayName)}
            contentClassName={avatarToneClassName(member.displayName)}
          />
        )}
        <div className="flex min-h-9 shrink-0 items-center gap-1">
          {ownedAgent && (
            <Button size="sm" color="secondary" href={localizeHref(`/messages/${member.id}`)}>
              {m.agent_private_chat()}
            </Button>
          )}
          <Dropdown.Root>
            <ButtonUtility
              icon={DotsVertical}
              size="sm"
              color="tertiary"
              tooltip={m.member_agent_actions({ name: member.displayName })}
            />
            <Dropdown.Popover placement="bottom end" className="w-44">
              <Dropdown.Menu
                onAction={(key) => {
                  if (key === "details") openProfile();
                  if (key === "delete") onDelete?.();
                }}
              >
                <Dropdown.Item id="details" icon={Eye} label={m.member_view_details()} />
                {onDelete ? (
                  <Dropdown.Item
                    id="delete"
                    icon={Trash01}
                    label={m.agent_profile_action_delete()}
                  />
                ) : null}
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown.Root>
        </div>
      </div>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <h2 className="min-w-0 truncate text-md font-semibold text-primary">
            <Link
              to="/agents"
              resetScroll={false}
              search={(previous) => ({
                ...previous,
                profile: formatAgentProfileParam(member.id),
              })}
              aria-label={m.agent_open_profile({ name: member.displayName })}
              aria-current={selected ? "page" : undefined}
              className="inline-flex min-h-11 items-center rounded-sm outline-focus-ring outline-offset-4 hover:underline focus-visible:outline-2 sm:min-h-0"
            >
              {member.displayName}
            </Link>
          </h2>
          <span className="flex max-w-[55%] min-w-0 shrink-0 items-center gap-1.5 rounded-full bg-secondary px-2.5 py-0.5 text-xs font-medium text-tertiary ring-1 ring-secondary ring-inset">
            <Monitor aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="truncate">
              {member.computerId === null
                ? m.member_no_computer()
                : member.computerName || m.agent_computer_unnamed()}
            </span>
          </span>
        </div>
        <p className="truncate text-sm text-tertiary">@{member.name}</p>
      </div>
      {/* Fixed two-line slot so every card in a row lines its footer up. */}
      <p className="line-clamp-2 min-h-10 text-sm leading-5 break-words text-secondary">
        {member.description}
      </p>
      <div className="mt-auto flex min-w-0 items-center gap-4 pt-1 text-sm text-tertiary">
        <span className="flex min-w-0 items-center gap-2">
          <Avatar
            size="xs"
            alt=""
            src={member.owner.avatarUrl ?? undefined}
            initials={avatarInitial(member.owner.displayName)}
            contentClassName={avatarToneClassName(member.owner.displayName)}
          />
          <span className="sr-only">{m.member_created_by()}</span>
          <span className="truncate">{member.owner.displayName}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <Calendar aria-hidden="true" className="size-4 text-fg-quaternary" />
          <span className="sr-only">{m.member_created_on()}</span>
          <time dateTime={new Date(member.createdAt).toISOString()}>{createdOn}</time>
        </span>
      </div>
    </GridListItem>
  );
}
