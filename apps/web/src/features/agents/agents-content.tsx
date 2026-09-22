import { useEffect, useState } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { Link, useRouter } from "@tanstack/react-router";
import { useBreakpoint } from "@/hooks/use-breakpoint";
import {
  MessageCircle01 as MessageCircle,
  Monitor01 as Monitor,
  Plus,
  SearchLg as Search,
  Users01 as UsersRound,
  UsersPlus,
} from "@untitledui/icons";

import { PageHeader } from "@/components/layout/page-header";
import { Avatar } from "@/components/base/avatar/avatar";
import { avatarInitial, avatarToneClassName } from "@/lib/avatar-tone";
import { localizeHref } from "@/paraglide/runtime";
import { Button } from "@/components/base/buttons/button";
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
import type { RuntimeCatalog } from "./agent-runtime-fields";
import type { CreateAgentInput } from "./agent.schemas";
import type { WorkspaceMemberDirectory } from "@/features/workspaces/workspaces.functions";
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

export type AgentView = {
  id: string;
  name: string;
  displayName: string;
  description?: string;
  status: AgentStatusView;
  display?: AgentDisplaySnapshot;
};

export function AgentsContent({
  directory,
  memberType,
  onMemberTypeChange,
  agents,
  computers,
  profileAgentId,
  agentTab,
  onCreate,
  onLoadRuntimeCatalog,
  onInviteMember,
  defaultCreateDialogOpen = false,
}: {
  directory: WorkspaceMemberDirectory;
  memberType: "all" | "human" | "agent";
  onMemberTypeChange: (value: "all" | "human" | "agent") => void;
  agents: AgentView[];
  computers: ComputerOption[];
  profileAgentId?: string;
  agentTab?: AgentProfileTab;
  onCreate: (input: CreateAgentInput) => Promise<{ startPublished: boolean }>;
  onLoadRuntimeCatalog: (computerId: string) => Promise<RuntimeCatalog[]>;
  onInviteMember: (input: { username: string; role: "admin" | "member" }) => Promise<void>;
  defaultCreateDialogOpen?: boolean;
}) {
  const router = useRouter();
  const { setAgentProfileTab, closeAgentProfile } = useOpenAgentProfile();
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(defaultCreateDialogOpen);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [deferredStart, setDeferredStart] = useState(false);
  const memberCount = directory.people.length + directory.agents.length;
  const canInviteMember = directory.actorRole === "owner" || directory.actorRole === "admin";
  // Agent creation requires Workspace owner/admin; see ManageAgents.create / assertCanCreateAgents.
  const canCreateAgent = canInviteMember;
  const memberTypes = [
    { value: "all", label: m.filters_all(), count: memberCount },
    { value: "human", label: m.member_person(), count: directory.people.length },
    { value: "agent", label: m.member_agent(), count: directory.agents.length },
  ] as const;
  const ownedAgents = new Map(agents.map((agent) => [agent.id, agent]));
  const query = search.trim().toLowerCase();
  const filteredPeople = directory.people.filter(
    (person) =>
      memberType !== "agent" &&
      `${person.displayName} ${person.name}`.toLowerCase().includes(query),
  );
  const filteredAgents = directory.agents.filter(
    (agent) =>
      memberType !== "human" &&
      `${agent.displayName} ${agent.name} ${agent.computerName ?? ""}`
        .toLowerCase()
        .includes(query),
  );
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
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader
        heading={m.navigation_agents()}
        actions={
          <>
            {canInviteMember && (
              <Button
                size="sm"
                color="secondary"
                iconLeading={UsersPlus}
                onPress={() => setInviteOpen(true)}
              >
                {m.workspace_invite_button()}
              </Button>
            )}
            {canCreateAgent && (
              <Button size="sm" color="secondary" iconLeading={Plus} onPress={() => setOpen(true)}>
                {m.header_new_agent()}
              </Button>
            )}
          </>
        }
      />
      {memberCount > 0 && (
        <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-secondary px-4 py-2 sm:px-6 md:h-11 md:flex-nowrap md:py-0">
          <div
            role="group"
            aria-label={m.member_type_filter()}
            className="flex h-9 max-w-full gap-0.5 rounded-lg bg-secondary p-0.5 ring-1 ring-secondary ring-inset"
          >
            {memberTypes.map(({ value, label, count }) => (
              <Button
                key={value}
                aria-label={label}
                color={memberType === value ? "secondary" : "tertiary"}
                className="h-8 gap-2 px-3 font-semibold aria-pressed:text-primary"
                aria-pressed={memberType === value}
                onPress={() => onMemberTypeChange(value)}
              >
                {label}
                <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-medium tabular-nums text-tertiary ring-1 ring-secondary ring-inset">
                  {count}
                </span>
              </Button>
            ))}
          </div>
          <label className="flex h-9 w-full items-center gap-2 rounded-lg bg-primary px-3 text-sm shadow-xs ring-1 ring-secondary transition-shadow focus-within:ring-2 focus-within:ring-brand ring-inset sm:ml-auto sm:w-72">
            <Search aria-hidden="true" className="size-5 shrink-0 text-tertiary" />
            <input
              type="search"
              aria-label={m.filters_search()}
              placeholder={`${m.filters_search()}...`}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-tertiary"
            />
          </label>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 sm:px-6">
        {deferredStart && (
          <p
            role="status"
            className="mt-5 rounded-lg border border-secondary bg-secondary px-4 py-3 text-sm text-tertiary"
          >
            {m.agent_deferred_start_notice()}
          </p>
        )}
        {filteredPeople.length + filteredAgents.length ? (
          <ul
            aria-label={m.navigation_agents()}
            className="mt-6 grid gap-5 md:grid-cols-[repeat(auto-fill,minmax(17rem,1fr))]"
          >
            {filteredPeople.map((person) => (
              <MemberCard key={`person:${person.id}`} member={person} label={m.member_person()} />
            ))}
            {filteredAgents.map((member) => (
              <MemberCard
                key={`agent:${member.id}`}
                member={member}
                label={m.member_agent()}
                computerName={member.computerName}
                ownedAgent={ownedAgents.get(member.id)}
                selected={member.id === profileAgentId}
                openProfile
              />
            ))}
          </ul>
        ) : (
          <Empty
            className={
              memberCount ? "gap-5 px-0 py-12" : "gap-6 px-0 pt-[clamp(3rem,12svh,7rem)] pb-10"
            }
          >
            <EmptyHeader className="max-w-xs gap-3">
              {memberCount ? (
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
                {memberCount
                  ? query
                    ? m.agent_no_search_results()
                    : memberType === "agent"
                      ? m.agent_empty_title()
                      : m.member_no_humans()
                  : m.agent_empty_title()}
              </EmptyTitle>
              <EmptyDescription>
                {memberCount
                  ? query
                    ? m.agent_search_description()
                    : m.member_type_empty_description()
                  : m.agent_empty_description()}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              {memberCount ? (
                <Button
                  color="secondary"
                  onPress={() => (query ? setSearch("") : onMemberTypeChange("all"))}
                >
                  {query ? m.agent_clear_search() : m.member_show_all()}
                </Button>
              ) : null}
            </EmptyContent>
          </Empty>
        )}
      </div>
    </div>
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
          await router.invalidate({ sync: true });
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
    </main>
  );
}

function MemberCard({
  member,
  label,
  computerName,
  ownedAgent,
  selected = false,
  openProfile = false,
}: {
  member: {
    id: string;
    name: string;
    displayName: string;
    description: string | null;
    avatarUrl?: string | null;
  };
  label: string;
  computerName?: string | null;
  ownedAgent?: AgentView;
  selected?: boolean;
  openProfile?: boolean;
}) {
  return (
    <li
      className={cn(
        "grid min-w-0 grid-cols-[3rem_minmax(0,1fr)_auto] grid-rows-[auto_3rem_auto] items-start gap-x-3 gap-y-3 rounded-xl bg-primary p-5 shadow-xs ring-1 ring-secondary ring-inset",
        selected && "ring-2 ring-brand",
      )}
    >
      {ownedAgent ? (
        <AgentDisplayAvatar
          name={member.displayName}
          src={member.avatarUrl}
          display={ownedAgent.display}
          size="xl"
        />
      ) : (
        <Avatar
          size="xl"
          alt={member.displayName}
          src={member.avatarUrl ?? undefined}
          initials={avatarInitial(member.displayName)}
          contentClassName={avatarToneClassName(member.displayName)}
        />
      )}
      <div className="min-w-0">
        <h2 className="line-clamp-2 break-words text-base font-semibold">
          {openProfile ? (
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
          ) : (
            member.displayName
          )}
        </h2>
        <p className="mt-0.5 truncate text-sm text-tertiary">@{member.name}</p>
      </div>
      {/* Fixed two-line slot so every card in the grid is the same height. */}
      <div className="col-span-3 row-start-2 min-h-12 min-w-0">
        {member.description && (
          <p className="line-clamp-2 break-words text-sm leading-6 text-tertiary">
            {member.description}
          </p>
        )}
      </div>
      <div className="col-span-3 row-start-3 flex min-w-0 items-center gap-3 self-end">
        <span className="shrink-0 rounded-md bg-secondary px-2 py-0.5 text-xs font-medium text-primary ring-1 ring-secondary ring-inset">
          {label}
        </span>
        {computerName !== undefined && (
          <p className="flex min-w-0 items-center gap-1.5 text-xs text-tertiary">
            <Monitor aria-hidden="true" className="size-4 shrink-0" />
            <span className="min-w-0 line-clamp-2 break-words">
              {computerName === null
                ? m.member_no_computer()
                : computerName || m.agent_computer_unnamed()}
            </span>
          </p>
        )}
      </div>
      {ownedAgent && (
        <ButtonUtility
          icon={MessageCircle}
          size="sm"
          color="secondary"
          tooltip={m.agent_private_chat()}
          className="col-start-3 row-start-1"
          href={localizeHref(`/messages/${member.id}`)}
        />
      )}
    </li>
  );
}
