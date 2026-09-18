import { useMemo, useState, type ReactNode } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { Monitor01 as Monitor, Plus, SearchLg as Search, UsersPlus } from "@untitledui/icons";

import { PageHeader } from "@/components/layout/page-header";
import { Avatar } from "@/components/base/avatar/avatar";
import { avatarInitial, avatarToneClassName } from "@/lib/avatar-tone";
import { Button } from "@/components/base/buttons/button";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import { m } from "@/paraglide/messages";
import { InviteMemberDialog } from "@/features/workspaces/invite-member-dialog";
import { computerIcon } from "@/features/computers/computer-identity";
import type { AgentStatusView } from "./agent-status-realtime";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import { AgentDisplayAvatar } from "./agent-activity-avatar";
import { AgentCreateDialog } from "./agent-create-dialog";
import type { RuntimeCatalog } from "./agent-runtime-fields";
import type { CreateAgentInput } from "./agent.schemas";
import type { WorkspaceMemberDirectory } from "@/features/workspaces/workspaces.functions";

type ComputerOption = {
  id: string;
  name: string;
  displayName: string;
  kind?: string;
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

type Agent = WorkspaceMemberDirectory["agents"][number];
type Person = WorkspaceMemberDirectory["people"][number];

/**
 * The Members page: a fixed-width list on the left (Agents grouped by their Computer, then
 * Humans) and a detail pane on the right. `/agents` renders it with `detail` empty; `/agents/$id`
 * renders it with the same `AgentProfilePanel` the conversation's right-hand slot uses — one
 * Agent profile UI, not two (see the route files for how each wires this up).
 */
export function MembersLayout({
  directory,
  agents,
  computers,
  selectedAgentId,
  detail,
  onCreate,
  onLoadRuntimeCatalog,
  onInviteMember,
  defaultCreateDialogOpen = false,
}: {
  directory: WorkspaceMemberDirectory;
  agents: AgentView[];
  computers: ComputerOption[];
  /** The Agent whose row is highlighted; `undefined` on the bare `/agents` list. */
  selectedAgentId?: string;
  /** The right column's content: an `AgentProfilePanel` on `/agents/$agentId`, or `undefined` for
   * the "select a member" empty state on `/agents`. */
  detail?: ReactNode;
  onCreate: (input: CreateAgentInput) => Promise<{ startPublished: boolean }>;
  onLoadRuntimeCatalog: (computerId: string) => Promise<RuntimeCatalog[]>;
  onInviteMember: (input: { username: string; role: "admin" | "member" }) => Promise<void>;
  defaultCreateDialogOpen?: boolean;
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(defaultCreateDialogOpen);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [deferredStart, setDeferredStart] = useState(false);
  const memberCount = directory.people.length + directory.agents.length;
  const canInviteMember = directory.actorRole === "owner" || directory.actorRole === "admin";
  // Agent creation requires Workspace owner/admin; see ManageAgents.create / assertCanCreateAgents.
  const canCreateAgent = canInviteMember;
  const ownedAgents = new Map(agents.map((agent) => [agent.id, agent]));
  const computerById = new Map(computers.map((computer) => [computer.id, computer]));

  const query = search.trim().toLowerCase();
  const filteredPeople = directory.people.filter((person) =>
    `${person.displayName} ${person.name}`.toLowerCase().includes(query),
  );
  const filteredAgents = directory.agents.filter((agent) =>
    `${agent.displayName} ${agent.name} ${agent.computerName ?? ""}`.toLowerCase().includes(query),
  );

  const computerGroups = useMemo(
    () => groupAgentsByComputer(filteredAgents, computerById),
    [filteredAgents, computerById],
  );

  const hasResults = filteredPeople.length + filteredAgents.length > 0;

  return (
    <main className="flex h-svh min-w-0">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-primary">
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
                <Button
                  size="sm"
                  color="secondary"
                  iconLeading={Plus}
                  onPress={() => setOpen(true)}
                >
                  {m.header_new_agent()}
                </Button>
              )}
            </>
          }
        />
        <div className="flex min-h-0 flex-1">
          <aside
            className={`flex w-full min-w-0 shrink-0 flex-col overflow-hidden border-r border-secondary md:w-80 ${
              selectedAgentId ? "hidden md:flex" : "flex"
            }`}
          >
            <div className="shrink-0 border-b border-secondary p-3">
              <label className="flex h-9 w-full items-center gap-2 rounded-lg bg-secondary px-3 text-sm ring-1 ring-secondary transition-shadow focus-within:ring-2 focus-within:ring-brand ring-inset">
                <Search aria-hidden="true" className="size-4 shrink-0 text-tertiary" />
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
            <div className="min-h-0 flex-1 overflow-y-auto">
              {deferredStart && (
                <p
                  role="status"
                  className="m-3 rounded-lg border border-secondary bg-secondary px-3 py-2 text-xs text-tertiary"
                >
                  {m.agent_deferred_start_notice()}
                </p>
              )}
              {hasResults ? (
                <>
                  <MemberSection
                    heading={m.member_agents_section({ count: filteredAgents.length })}
                  >
                    {computerGroups.map((group) => (
                      <ComputerGroup
                        key={group.key}
                        group={group}
                        ownedAgents={ownedAgents}
                        selectedAgentId={selectedAgentId}
                      />
                    ))}
                  </MemberSection>
                  <MemberSection
                    heading={m.member_humans_section({ count: filteredPeople.length })}
                  >
                    <ul>
                      {filteredPeople.map((person) => (
                        <PersonRow key={person.id} person={person} />
                      ))}
                    </ul>
                  </MemberSection>
                </>
              ) : (
                <Empty className="gap-4 px-4 py-10 text-center">
                  <EmptyHeader className="items-center gap-3">
                    <EmptyMedia>
                      <Search
                        aria-hidden="true"
                        className="size-6 text-tertiary"
                        strokeWidth={1.5}
                      />
                    </EmptyMedia>
                    <EmptyTitle role="heading" aria-level={2} className="text-sm font-semibold">
                      {memberCount ? m.agent_no_search_results() : m.agent_empty_title()}
                    </EmptyTitle>
                    <EmptyDescription className="text-xs">
                      {memberCount ? m.agent_search_description() : m.agent_empty_description()}
                    </EmptyDescription>
                  </EmptyHeader>
                  {query && (
                    <Button size="sm" color="secondary" onPress={() => setSearch("")}>
                      {m.agent_clear_search()}
                    </Button>
                  )}
                </Empty>
              )}
            </div>
          </aside>

          <section
            className={`min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${
              selectedAgentId ? "flex" : "hidden md:flex"
            }`}
          >
            {detail ?? (
              <Empty className="h-full flex-1 items-center justify-center px-6 text-center">
                <EmptyHeader className="items-center gap-3">
                  <EmptyMedia>
                    <Search aria-hidden="true" className="size-6 text-tertiary" strokeWidth={1.5} />
                  </EmptyMedia>
                  <EmptyTitle role="heading" aria-level={2}>
                    {m.members_select_prompt_title()}
                  </EmptyTitle>
                  <EmptyDescription>{m.members_select_prompt_description()}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </section>
        </div>
      </div>

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

function MemberSection({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <div className="py-2">
      <p className="px-3 py-1.5 text-xs font-semibold tracking-wide text-tertiary uppercase">
        {heading}
      </p>
      {children}
    </div>
  );
}

type ComputerAgentGroup = {
  key: string;
  computerId: string | null;
  label: string;
  kind?: string;
  agents: Agent[];
};

function groupAgentsByComputer(
  agents: Agent[],
  computerById: Map<string, { displayName: string; kind?: string }>,
): ComputerAgentGroup[] {
  const groups = new Map<string, ComputerAgentGroup>();
  for (const agent of agents) {
    const computerId = agent.computerId ?? null;
    const key = computerId ?? "__none__";
    let group = groups.get(key);
    if (!group) {
      const computer = computerId ? computerById.get(computerId) : undefined;
      group = {
        key,
        computerId,
        label: computerId
          ? agent.computerName || computer?.displayName || m.agent_computer_unnamed()
          : m.member_no_computer(),
        kind: computer?.kind,
        agents: [],
      };
      groups.set(key, group);
    }
    group.agents.push(agent);
  }
  // Named-computer groups first (alphabetically), "No computer" last.
  return [...groups.values()].sort((a, b) => {
    if (a.computerId === null) return 1;
    if (b.computerId === null) return -1;
    return a.label.localeCompare(b.label);
  });
}

function ComputerGroup({
  group,
  ownedAgents,
  selectedAgentId,
}: {
  group: ComputerAgentGroup;
  ownedAgents: Map<string, AgentView>;
  selectedAgentId?: string;
}) {
  const Icon = group.computerId
    ? computerIcon({ kind: group.kind ?? "local", name: group.label, displayName: group.label })
    : Monitor;
  return (
    <div>
      <div className="flex items-center gap-1.5 px-3 py-1 text-xs text-tertiary">
        <Icon aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{group.label}</span>
        <span className="tabular-nums">{group.agents.length}</span>
      </div>
      <ul>
        {group.agents.map((agent) => (
          <AgentRow
            key={agent.id}
            agent={agent}
            ownedAgent={ownedAgents.get(agent.id)}
            selected={agent.id === selectedAgentId}
          />
        ))}
      </ul>
    </div>
  );
}

function AgentRow({
  agent,
  ownedAgent,
  selected,
}: {
  agent: Agent;
  ownedAgent?: AgentView;
  selected: boolean;
}) {
  return (
    <li>
      <Link
        to="/agents/$agentId"
        params={{ agentId: agent.id }}
        search={{ agentTab: "profile" }}
        aria-current={selected ? "page" : undefined}
        className={`flex min-w-0 items-center gap-2.5 px-3 py-2 text-sm outline-focus-ring outline-offset-[-2px] hover:bg-primary_hover focus-visible:outline-2 ${
          selected ? "bg-secondary" : ""
        }`}
      >
        {ownedAgent ? (
          <AgentDisplayAvatar name={agent.displayName} display={ownedAgent.display} size="sm" />
        ) : (
          <Avatar
            size="sm"
            alt=""
            initials={avatarInitial(agent.displayName)}
            contentClassName={avatarToneClassName(agent.displayName)}
          />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-primary">{agent.displayName}</p>
          {agent.description && (
            <p className="truncate text-xs text-tertiary">{agent.description}</p>
          )}
        </div>
      </Link>
    </li>
  );
}

function PersonRow({ person }: { person: Person }) {
  // Humans have no `/agents/$id` destination in this PR (see the brief); a plain row, not a link.
  return (
    <li className="flex min-w-0 items-center gap-2.5 px-3 py-2 text-sm">
      <Avatar
        size="sm"
        alt=""
        initials={avatarInitial(person.displayName)}
        contentClassName={avatarToneClassName(person.displayName)}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-primary">{person.displayName}</p>
        {person.description && (
          <p className="truncate text-xs text-tertiary">{person.description}</p>
        )}
      </div>
    </li>
  );
}
