import { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Button as AriaButton,
  Checkbox as AriaCheckbox,
  Disclosure,
  DisclosurePanel,
  Heading,
  Text,
} from "react-aria-components";
import { ChevronDown, Plus, SearchLg } from "@untitledui/icons";

import { Dialog, Modal, ModalOverlay } from "#src/components/application/modals/modal";
import { DialogHeader } from "#src/components/application/modals/dialog-header";
import { Avatar } from "#src/components/base/avatar/avatar";
import { Badge, BadgeWithButton } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { CheckboxBase } from "#src/components/base/checkbox/checkbox";
import { Input } from "#src/components/base/input/input";
import { AgentCreateDialog } from "#src/features/agents/agent-create-dialog";
import { createAgent } from "#src/features/agents/agents.functions";
import { AgentDisplayAvatar } from "#src/features/agents/agent-activity-avatar";
import { agentDisplay } from "#src/features/agents/agent-activity-presentation";
import { useAgentDisplays } from "#src/features/agents/workspace-agents-realtime";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";
import {
  getComputerRuntimeCatalog,
  listComputers,
} from "#src/features/computers/computers.functions";
import { avatarInitial, avatarToneClassName } from "#src/lib/avatar-tone";
import { isAppError } from "#src/lib/app-error";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import {
  addPublicChannelMembers,
  loadPublicChannelMembers,
  removePublicChannelMember,
  setPublicChannelMemberRole,
} from "./channels.functions";
import { channelMembersQueryKey } from "./conversation-query-keys";

type ChannelMembers = Awaited<ReturnType<typeof loadPublicChannelMembers>>;
type Member = { kind: "user" | "agent" } & (
  | ChannelMembers["humans"][number]
  | ChannelMembers["agents"][number]
);

/** The two views of the members page: the roster, and adding people to it. */
export type ChannelMembersView = "members" | "add";

/** The members roster the panel's Members strip also reads: one query per channel. */
export function useChannelMembers(channelId: string) {
  const load = useServerFn(loadPublicChannelMembers);
  return useQuery({
    queryKey: channelMembersQueryKey(channelId),
    queryFn: () => load({ data: { channelId } }),
    refetchOnWindowFocus: true,
  });
}

function matches(query: string, ...values: string[]) {
  return !query || values.some((value) => value.toLowerCase().includes(query));
}

/** A Workspace owner or admin administers every channel, whatever their role in it. */
function isServerAdmin(member: { serverRole?: string | null }) {
  return member.serverRole === "owner" || member.serverRole === "admin";
}

/** Owner and admin are Workspace roles; a channel admin is one by this channel's own role. */
function roleLabel(member: { serverRole?: string | null; channelRole: string }) {
  if (member.serverRole === "owner") return m.channel_members_role_owner();
  if (member.serverRole === "admin") return m.channel_members_role_admin();
  if (member.channelRole === "admin") return m.channel_members_role_channel_admin();
  return m.channel_members_role_member();
}

/**
 * A channel's members as a page of its settings panel: the roster grouped by humans and Agents
 * with a search, each row's role and, for those allowed, its role and remove actions; and the
 * add view, where a member picks Workspace Agents and people to add, or creates an Agent that then
 * joins. It reads and updates the same query as the panel's Members strip.
 */
export function ChannelMembersPage({
  channelId,
  channelName,
  viewerHandle,
  canCreateAgents,
  view,
  onViewChange,
  roster,
}: {
  channelId: string;
  channelName: string;
  /** The viewer's own username: their row offers no role change. */
  viewerHandle?: string;
  /** Whether the add view may create an Agent (a Workspace owner or admin). */
  canCreateAgents: boolean;
  view: ChannelMembersView;
  onViewChange: (view: ChannelMembersView) => void;
  roster: RosterState;
}) {
  const members = useChannelMembers(channelId);
  const createdAgentJoin = useCreatedAgentJoin(channelId);
  if (members.isPending)
    return <p className="px-4 py-6 text-sm text-tertiary md:px-6">{m.channel_members_loading()}</p>;
  if (members.isError)
    return (
      <p role="alert" className="px-4 py-6 text-sm text-error-primary md:px-6">
        {m.channel_members_load_error()}
      </p>
    );
  return view === "add" ? (
    <AddMembersView
      channelId={channelId}
      channelName={channelName}
      canCreateAgents={canCreateAgents}
      createdAgentJoin={createdAgentJoin}
      data={members.data}
      onDone={() => onViewChange("members")}
    />
  ) : (
    <MembersRoster
      channelId={channelId}
      channelName={channelName}
      viewerHandle={viewerHandle}
      data={members.data}
      onAdd={() => onViewChange("add")}
      roster={roster}
    />
  );
}

/** The roster's state that outlives it while an Agent's profile is open in its place, so Back
 * returns to the same search, with focus on the row that opened the profile. */
export type RosterState = {
  search: string;
  onSearchChange: (search: string) => void;
  onOpenAgentProfile: (agentId: string) => void;
  /** The Agent whose profile was just left: its row takes focus. */
  returnFocusAgentId?: string;
};

function MembersRoster({
  channelId,
  channelName,
  viewerHandle,
  data,
  onAdd,
  roster: { search, onSearchChange, onOpenAgentProfile, returnFocusAgentId },
}: {
  channelId: string;
  channelName: string;
  viewerHandle?: string;
  data: ChannelMembers;
  onAdd: () => void;
  roster: RosterState;
}) {
  const queryClient = useQueryClient();
  const setRole = useServerFn(setPublicChannelMemberRole);
  const displays = useAgentDisplays();
  const [roleTarget, setRoleTarget] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState<Member | null>(null);
  const [serverAdmin, setServerAdmin] = useState<Member | null>(null);
  const query = search.trim().toLowerCase();
  const humans = useMemo(
    () =>
      data.humans
        .filter((human) => matches(query, human.displayName, human.username))
        .map((human): Member => ({ kind: "user", ...human })),
    [data.humans, query],
  );
  const agents = useMemo(
    () =>
      data.agents
        .filter((agent) => matches(query, agent.displayName, agent.name))
        .map((agent): Member => ({ kind: "agent", ...agent })),
    [data.agents, query],
  );
  const total = data.humans.length + data.agents.length;
  const hasCandidates = data.candidates.humans.length + data.candidates.agents.length > 0;
  const canManageRoles = data.channelCapabilities.manage_roles;

  // Stable across renders, so a live status update re-renders only the rows whose display changed.
  const toggleRole = useCallback(
    async (member: Member) => {
      if (isServerAdmin(member)) {
        setServerAdmin(member);
        return;
      }
      setRoleTarget(member.id);
      setError("");
      try {
        await setRole({
          data: {
            channelId,
            ...(member.kind === "user" ? { userId: member.id } : { agentId: member.id }),
            role: member.channelRole === "admin" ? "member" : "admin",
          },
        });
        await queryClient.invalidateQueries({ queryKey: channelMembersQueryKey(channelId) });
      } catch {
        setError(m.channel_members_role_error());
      } finally {
        setRoleTarget(null);
      }
    },
    [channelId, queryClient, setRole],
  );
  function rowFor(member: Member) {
    const self = "username" in member && member.username === viewerHandle;
    return (
      <MemberRow
        key={`${member.kind}:${member.id}`}
        member={member}
        display={member.kind === "agent" ? displays.get(member.id) : undefined}
        canChangeRole={canManageRoles && !self}
        roleBusy={roleTarget === member.id}
        canRemove={data.canRemoveMembers}
        onToggleRole={toggleRole}
        onRemove={setRemoving}
        onOpenAgentProfile={onOpenAgentProfile}
        autoFocus={member.kind === "agent" && member.id === returnFocusAgentId}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-secondary px-4 py-3 md:px-6">
        <Input
          size="sm"
          aria-label={m.channel_members_search_placeholder()}
          placeholder={m.channel_members_search_placeholder()}
          icon={SearchLg}
          value={search}
          onChange={onSearchChange}
        />
      </div>
      {error && (
        <p role="alert" className="px-4 pt-3 text-sm text-error-primary md:px-6">
          {error}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto py-2">
        {humans.length > 0 && (
          <MemberGroup label={m.channel_members_humans()} count={humans.length}>
            {humans.map(rowFor)}
          </MemberGroup>
        )}
        {agents.length > 0 && (
          <MemberGroup label={m.channel_members_agents()} count={agents.length}>
            {agents.map(rowFor)}
          </MemberGroup>
        )}
        {total === 0 && (
          <p className="px-4 py-4 text-center text-sm text-tertiary md:px-6">
            {m.channel_members_none()}
          </p>
        )}
        {total > 0 && humans.length === 0 && agents.length === 0 && (
          <p className="px-4 py-4 text-center text-sm text-tertiary md:px-6">
            {m.channel_members_no_matches({ query: search.trim() })}
          </p>
        )}
      </div>
      {data.canAddMembers && (
        <div className="shrink-0 border-t border-secondary px-4 py-3 md:px-6">
          <Button
            color="secondary"
            iconLeading={Plus}
            className="w-full"
            isDisabled={!hasCandidates}
            onPress={onAdd}
          >
            {m.channel_members_add_member()}
          </Button>
        </div>
      )}
      {removing && (
        <RemoveMemberDialog
          channelId={channelId}
          channelName={channelName}
          member={removing}
          onClose={() => setRemoving(null)}
        />
      )}
      {serverAdmin && (
        <ServerAdminRoleDialog member={serverAdmin} onClose={() => setServerAdmin(null)} />
      )}
    </div>
  );
}

/** One roster row: identity, the role, and (revealed on hover or keyboard focus, always shown on
 * touch widths) the role and remove actions. */
const MemberRow = memo(function MemberRow({
  member,
  display,
  canChangeRole,
  roleBusy,
  canRemove,
  onToggleRole,
  onRemove,
  onOpenAgentProfile,
  autoFocus,
}: {
  member: Member;
  display: AgentDisplaySnapshot | undefined;
  canChangeRole: boolean;
  roleBusy: boolean;
  canRemove: boolean;
  onToggleRole: (member: Member) => void;
  onRemove: (member: Member) => void;
  onOpenAgentProfile: (agentId: string) => void;
  autoFocus: boolean;
}) {
  const hasActions = canChangeRole || canRemove;
  const identity = (
    <>
      {member.kind === "agent" ? (
        <AgentDisplayAvatar name={member.displayName} src={member.avatarUrl} display={display} />
      ) : (
        <Avatar
          size="sm"
          alt=""
          src={member.avatarUrl ?? undefined}
          initials={avatarInitial(member.displayName)}
          contentClassName={avatarToneClassName(member.displayName)}
        />
      )}
      <span className="min-w-0 flex-1 text-left">
        <span
          className={cn(
            "block truncate text-sm text-primary",
            member.kind === "user" ? "font-semibold" : "font-medium",
          )}
        >
          {member.displayName}
        </span>
        {member.kind === "agent" && (
          <span className="block truncate text-xs text-tertiary">
            {agentDisplay(display).label}
          </span>
        )}
      </span>
    </>
  );
  return (
    <li className="group flex items-center gap-3 px-4 py-2 md:px-6">
      {member.kind === "agent" ? (
        <AriaButton
          aria-label={m.agent_open_profile({ name: member.displayName })}
          autoFocus={autoFocus}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-md outline-focus-ring focus-visible:outline-2"
          onPress={() => onOpenAgentProfile(member.id)}
        >
          {identity}
        </AriaButton>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-3">{identity}</span>
      )}
      {/* Hidden by opacity, not visibility, so the actions stay in the tab order and a keyboard
          focus reveals them. */}
      <span className="flex shrink-0 items-center gap-2 md:grid">
        <span
          className={cn(
            "flex items-center md:col-start-1 md:row-start-1 md:justify-self-end",
            hasActions && "md:group-focus-within:opacity-0 md:group-hover:opacity-0",
          )}
        >
          <Badge size="sm" color="gray">
            {roleLabel(member)}
          </Badge>
        </span>
        {hasActions && (
          <span className="flex items-center gap-2 md:col-start-1 md:row-start-1 md:justify-self-end md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100">
            {canChangeRole && (
              <Button
                size="sm"
                color="secondary"
                isDisabled={roleBusy}
                aria-label={
                  member.channelRole === "admin" || isServerAdmin(member)
                    ? m.channel_members_demote_name({ name: member.displayName })
                    : m.channel_members_promote_name({ name: member.displayName })
                }
                onPress={() => onToggleRole(member)}
              >
                {member.channelRole === "admin" || isServerAdmin(member)
                  ? m.channel_members_demote()
                  : m.channel_members_promote()}
              </Button>
            )}
            {canRemove && (
              <Button
                size="sm"
                color="tertiary-destructive"
                aria-label={m.channel_members_remove_name({ name: member.displayName })}
                onPress={() => onRemove(member)}
              >
                {m.channel_members_remove_action()}
              </Button>
            )}
          </span>
        )}
      </span>
    </li>
  );
});

function MemberGroup({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(true);
  return (
    <Disclosure isExpanded={expanded} onExpandedChange={setExpanded}>
      <Heading level={3}>
        <AriaButton
          slot="trigger"
          className="flex w-full cursor-pointer items-center gap-1.5 px-4 py-2 text-xs font-semibold text-tertiary outline-focus-ring focus-visible:outline-2 focus-visible:-outline-offset-2 md:px-6"
        >
          <ChevronDown
            aria-hidden="true"
            className={cn("size-4 shrink-0 transition-transform", !expanded && "-rotate-90")}
          />
          <span>
            {label} · <span className="tabular-nums">{count}</span>
          </span>
        </AriaButton>
      </Heading>
      {/* A collapsed panel is `hidden="until-found"`, which Tailwind's preflight leaves displayed. */}
      <DisclosurePanel className={cn(!expanded && "hidden")}>
        <ul>{expanded && children}</ul>
      </DisclosurePanel>
    </Disclosure>
  );
}

/** A Workspace owner or admin stays a channel admin everywhere; their row explains that instead
 * of demoting them. */
function ServerAdminRoleDialog({ member, onClose }: { member: Member; onClose: () => void }) {
  return (
    <ModalOverlay isOpen onOpenChange={(next) => !next && onClose()}>
      <Modal className="w-[calc(100vw-2rem)] max-w-md">
        <Dialog className="overflow-hidden text-left">
          {({ close }) => (
            <>
              <DialogHeader title={m.channel_members_server_admin_title()} onClose={close} />
              <Text slot="description" className="mx-6 mt-4 block text-sm text-secondary">
                {m.channel_members_server_admin_message({ name: member.displayName })}
              </Text>
              <div className="mt-6 flex justify-end border-t border-secondary px-6 py-4">
                <Button color="secondary" onPress={close}>
                  {m.channel_members_ok()}
                </Button>
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function RemoveMemberDialog({
  channelId,
  channelName,
  member,
  onClose,
}: {
  channelId: string;
  channelName: string;
  member: Member;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const remove = useServerFn(removePublicChannelMember);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function confirm() {
    setBusy(true);
    setError("");
    try {
      await remove({
        data: {
          channelId,
          ...(member.kind === "user" ? { userId: member.id } : { agentId: member.id }),
        },
      });
      await queryClient.invalidateQueries({ queryKey: channelMembersQueryKey(channelId) });
      onClose();
    } catch {
      setError(m.channel_members_remove_error({ name: member.displayName }));
      setBusy(false);
    }
  }

  return (
    <ModalOverlay
      isOpen
      isDismissable={!busy}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <Modal className="w-[calc(100vw-2rem)] max-w-md">
        <Dialog className="overflow-hidden text-left">
          {({ close }) => (
            <>
              <DialogHeader
                title={m.channel_members_remove_title()}
                onClose={busy ? undefined : close}
              />
              <Text slot="description" className="mx-6 mt-4 block text-sm text-secondary">
                {m.channel_members_remove_message({
                  name: member.displayName,
                  channel: channelName,
                })}
              </Text>
              {error && (
                <p role="alert" className="px-6 pt-4 text-sm text-error-primary">
                  {error}
                </p>
              )}
              <div className="mt-6 flex justify-end gap-3 border-t border-secondary px-6 py-4">
                <Button color="secondary" isDisabled={busy} onPress={close}>
                  {m.channel_members_cancel()}
                </Button>
                <Button
                  color="primary-destructive"
                  isDisabled={busy}
                  isLoading={busy}
                  showTextWhileLoading
                  onPress={() => void confirm()}
                >
                  {busy ? m.channel_members_removing() : m.channel_members_remove_action()}
                </Button>
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

type Candidate = {
  key: string;
  kind: "user" | "agent";
  id: string;
  displayName: string;
  handle: string;
  description?: string;
  avatarUrl?: string | null;
};

function AddMembersView({
  channelId,
  channelName,
  canCreateAgents,
  createdAgentJoin,
  data,
  onDone,
}: {
  channelId: string;
  channelName: string;
  canCreateAgents: boolean;
  createdAgentJoin: CreatedAgentJoin;
  data: ChannelMembers;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const add = useServerFn(addPublicChannelMembers);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const candidates = useMemo<Candidate[]>(
    () => [
      ...data.candidates.agents.map((agent) => ({
        key: `agent:${agent.id}`,
        kind: "agent" as const,
        id: agent.id,
        displayName: agent.displayName,
        handle: agent.name,
        description: agent.description,
        avatarUrl: agent.avatarUrl,
      })),
      ...data.candidates.humans.map((human) => ({
        key: `user:${human.id}`,
        kind: "user" as const,
        id: human.id,
        displayName: human.displayName,
        handle: human.username,
        avatarUrl: human.avatarUrl,
      })),
    ],
    [data.candidates],
  );
  const byKey = useMemo(() => new Map(candidates.map((entry) => [entry.key, entry])), [candidates]);
  // A leading @ is how people write a handle; it is not part of the name.
  const term = search.trim().replace(/^@/, "");
  const query = term.toLowerCase();
  const shown = useMemo(
    () => candidates.filter((entry) => matches(query, entry.displayName, entry.handle)),
    [candidates, query],
  );
  const shownAgents = shown.filter((entry) => entry.kind === "agent");
  const shownHumans = shown.filter((entry) => entry.kind === "user");
  const { joining, failure, notStarted } = createdAgentJoin;
  // Joined some other way meanwhile (a refetch, another member): nothing left to retry.
  const unjoined =
    failure && !data.agents.some((agent) => agent.id === failure.agent.id) ? failure : null;
  const createName = term && shown.length === 0 ? term : "";

  async function joinCreated(agent: CreatedAgent, startPublished: boolean) {
    if (await createdAgentJoin.join(agent, startPublished)) {
      // The search named the new Agent; clear it so the list stops offering to create it again.
      setSearch("");
    } else {
      // Like any pick, the new Agent is selected, so Add selected retries it too.
      setSelected((previous) => new Set(previous).add(`agent:${agent.id}`));
    }
  }

  function toggle(key: string, on: boolean) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
    setError("");
  }

  async function submit() {
    if (selected.size === 0) return;
    setBusy(true);
    setError("");
    // A candidate a refetch no longer lists (added meanwhile) drops out of the selection.
    const picked = [...selected].flatMap((key) => byKey.get(key) ?? []);
    try {
      const fresh = await add({
        data: {
          channelId,
          userIds: picked.filter((entry) => entry.kind === "user").map((entry) => entry.id),
          agentIds: picked.filter((entry) => entry.kind === "agent").map((entry) => entry.id),
        },
      });
      queryClient.setQueryData(channelMembersQueryKey(channelId), fresh);
      onDone();
    } catch (cause) {
      setError(
        isAppError(cause) && cause.code === "ACCESS_DENIED"
          ? m.channel_members_access_denied()
          : m.channel_members_add_error(),
      );
    } finally {
      setBusy(false);
    }
  }

  function candidateRow(entry: Candidate) {
    const description = entry.description?.trim();
    // React Aria's checkbox around the official box, so the row can hold an avatar: the official
    // `Checkbox` puts its label in a `<p>`, which cannot contain the avatar's `<div>`.
    return (
      <li key={entry.key}>
        <AriaCheckbox
          isSelected={selected.has(entry.key)}
          isDisabled={busy}
          onChange={(on) => toggle(entry.key, on)}
          aria-label={entry.displayName}
          className="flex w-full cursor-pointer items-center gap-2 px-4 py-2 hover:bg-primary_hover disabled:cursor-not-allowed md:px-6"
        >
          {({ isSelected, isDisabled, isFocusVisible }) => (
            <>
              <CheckboxBase
                isSelected={isSelected}
                isDisabled={isDisabled}
                isFocusVisible={isFocusVisible}
              />
              <Avatar
                size="xs"
                alt=""
                src={entry.avatarUrl ?? undefined}
                initials={avatarInitial(entry.displayName)}
                contentClassName={avatarToneClassName(entry.displayName)}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-primary">
                  {entry.displayName}
                </span>
                {description && (
                  <span className="block truncate text-xs text-tertiary">{description}</span>
                )}
              </span>
            </>
          )}
        </AriaCheckbox>
      </li>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-3 border-b border-secondary px-4 py-3 md:px-6">
        {unjoined && (
          <div
            role="alert"
            className="flex flex-col gap-2 rounded-lg bg-warning-primary px-3 py-2.5"
          >
            <p className="text-sm font-medium text-warning-primary">
              {m.channel_members_create_agent_join_failed({
                name: unjoined.agent.name,
                channel: channelName,
              })}
            </p>
            <p className="text-sm text-secondary">{unjoined.reason}</p>
            {unjoined.retryable && (
              <Button
                size="sm"
                color="secondary"
                className="self-start"
                isDisabled={busy || joining}
                isLoading={joining}
                showTextWhileLoading
                onPress={() => void joinCreated(unjoined.agent, !notStarted)}
              >
                {m.channel_members_retry_join()}
              </Button>
            )}
          </div>
        )}
        {notStarted && (
          <p role="status" className="text-sm text-secondary">
            {m.agent_deferred_start_notice()}
          </p>
        )}
        {selected.size > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {[...selected].map((key) => {
              const entry = byKey.get(key);
              if (!entry) return null;
              return (
                <BadgeWithButton
                  key={key}
                  size="sm"
                  color={entry.kind === "agent" ? "brand" : "gray"}
                  buttonLabel={m.channel_members_deselect({ name: entry.displayName })}
                  onButtonClick={() => toggle(key, false)}
                >
                  {entry.displayName}
                </BadgeWithButton>
              );
            })}
          </div>
        )}
        <Input
          size="sm"
          label={m.channel_members_search()}
          placeholder={m.channel_members_name_placeholder()}
          icon={SearchLg}
          value={search}
          onChange={setSearch}
          autoFocus
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-2">
        {shownAgents.length > 0 && (
          <>
            <h3 className="px-4 py-2 text-xs font-semibold text-tertiary md:px-6">
              {m.channel_members_agents()}
            </h3>
            <ul>{shownAgents.map(candidateRow)}</ul>
          </>
        )}
        {shownHumans.length > 0 && (
          <>
            <h3 className="px-4 py-2 text-xs font-semibold text-tertiary md:px-6">
              {m.channel_members_humans()}
            </h3>
            <ul>{shownHumans.map(candidateRow)}</ul>
          </>
        )}
        {candidates.length === 0 && (
          <p className="px-4 py-4 text-center text-sm text-tertiary md:px-6">
            {m.channel_members_all_added()}
          </p>
        )}
        {candidates.length > 0 && shown.length === 0 && (
          <p className="px-4 py-4 text-center text-sm text-tertiary md:px-6">
            {m.channel_members_no_matches({ query: term })}
          </p>
        )}
      </div>
      <CreateAgentEntry
        channelName={channelName}
        canCreate={canCreateAgents}
        name={createName}
        nameNote={createName ? prefillNote(search.trim(), createName) : undefined}
        // A created Agent that has not joined yet is retried above, never created again.
        disabled={busy || joining || unjoined !== null}
        onCreated={(agent, startPublished) => void joinCreated(agent, startPublished)}
      />
      <div className="flex shrink-0 flex-col gap-2 border-t border-secondary px-4 py-3 md:px-6">
        {error && (
          <p role="alert" className="text-sm text-error-primary">
            {error}
          </p>
        )}
        <Button
          iconLeading={Plus}
          className="w-full"
          isDisabled={busy || joining || selected.size === 0}
          isLoading={busy}
          showTextWhileLoading
          onPress={() => void submit()}
        >
          {busy
            ? m.channel_members_adding()
            : m.channel_members_add_selected({ count: selected.size })}
        </Button>
      </div>
    </div>
  );
}

type CreatedAgent = { id: string; name: string };
type CreatedAgentJoin = ReturnType<typeof useCreatedAgentJoin>;

/** Why a created Agent did not join, and whether trying again can help. */
function joinFailure(cause: unknown) {
  if (isAppError(cause) && cause.code === "ACCESS_DENIED")
    return { reason: m.channel_members_access_denied(), retryable: false };
  if (isAppError(cause) && cause.code === "CONFLICT")
    return { reason: m.channel_archived_notice(), retryable: false };
  return { reason: m.channel_members_create_agent_join_failed_hint(), retryable: true };
}

/** What the name field says about a name taken from the search: a stripped leading @, and spaces
 * the username cannot hold, which are left for the person to resolve. */
function prefillNote(search: string, name: string) {
  const notes = [
    ...(search.startsWith("@") ? [m.channel_members_prefill_at_stripped()] : []),
    ...(/\s/.test(name)
      ? [
          m.channel_members_prefill_spaces_kept({
            dashed: name.replace(/\s+/g, "-"),
            joined: name.replace(/\s+/g, ""),
          }),
        ]
      : []),
  ];
  return notes.join(" ") || undefined;
}

/**
 * Adds an Agent just created from the add view to the channel. Held by the members page rather
 * than the add view, so a join still running when the add view closes keeps its outcome.
 */
function useCreatedAgentJoin(channelId: string) {
  const queryClient = useQueryClient();
  const add = useServerFn(addPublicChannelMembers);
  const [joining, setJoining] = useState(false);
  const [failure, setFailure] = useState<
    ({ agent: CreatedAgent } & ReturnType<typeof joinFailure>) | null
  >(null);
  const [notStarted, setNotStarted] = useState(false);

  /** Resolves `true` once the Agent is in the channel. */
  async function join(agent: CreatedAgent, startPublished: boolean) {
    setJoining(true);
    setNotStarted(!startPublished);
    try {
      const fresh = await add({ data: { channelId, userIds: [], agentIds: [agent.id] } });
      queryClient.setQueryData(channelMembersQueryKey(channelId), fresh);
      setFailure(null);
      return true;
    } catch (cause) {
      setFailure({ agent, ...joinFailure(cause) });
      // The new Agent is a candidate now; list it.
      void queryClient.invalidateQueries({ queryKey: channelMembersQueryKey(channelId) });
      return false;
    } finally {
      setJoining(false);
    }
  }

  return { joining, failure, notStarted, join };
}

/** The add view's last row: create an Agent (named after a search that matched nobody) that joins
 * the channel once created. A viewer who may not create Agents sees why instead. */
function CreateAgentEntry({
  channelName,
  canCreate,
  name,
  nameNote,
  disabled,
  onCreated,
}: {
  channelName: string;
  canCreate: boolean;
  /** The search that matched nobody, or empty. */
  name: string;
  nameNote?: string;
  disabled: boolean;
  onCreated: (agent: CreatedAgent, startPublished: boolean) => void;
}) {
  const loadComputers = useServerFn(listComputers);
  const loadRuntimeCatalog = useServerFn(getComputerRuntimeCatalog);
  const create = useServerFn(createAgent);
  const [computers, setComputers] = useState<Awaited<ReturnType<typeof listComputers>>>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");

  async function open() {
    setLoading(true);
    setLoadError("");
    try {
      // Read on every open: a Computer may have come online or gone since the last one.
      setComputers(await loadComputers());
      setDialogOpen(true);
    } catch {
      setLoadError(m.channel_members_computers_error());
    } finally {
      setLoading(false);
    }
  }

  if (!canCreate)
    return (
      <div className="shrink-0 border-t border-secondary px-4 py-3 md:px-6">
        <p className="flex items-center gap-2 text-sm font-medium text-quaternary">
          <Plus aria-hidden="true" className="size-4 shrink-0" />
          {m.channel_members_create_agent()}
        </p>
        <p className="mt-1 text-sm text-tertiary">{m.channel_members_create_agent_denied()}</p>
      </div>
    );

  return (
    <div className="shrink-0 border-t border-secondary">
      {loadError && (
        <p role="alert" className="px-4 pt-3 text-sm text-error-primary md:px-6">
          {loadError}
        </p>
      )}
      <AriaButton
        isDisabled={disabled || loading}
        onPress={() => void open()}
        className={cn(
          "flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left outline-focus-ring hover:bg-primary_hover focus-visible:outline-2 focus-visible:-outline-offset-2 disabled:cursor-not-allowed disabled:opacity-60 md:px-6",
          name && "bg-secondary",
        )}
      >
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-dashed border-primary text-fg-quaternary">
          <Plus aria-hidden="true" className="size-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-primary">
            {name
              ? m.channel_members_create_agent_named({ name })
              : m.channel_members_create_agent()}
          </span>
          <span className="block truncate text-sm text-tertiary">
            {m.channel_members_create_agent_joins({ channel: channelName })}
          </span>
        </span>
      </AriaButton>
      {dialogOpen && computers && (
        <AgentCreateDialog
          open
          onOpenChange={setDialogOpen}
          computers={computers}
          onLoadRuntimeCatalog={(computerId) => loadRuntimeCatalog({ data: { computerId } })}
          // Read once when the form mounts, so typing afterwards does not rename the draft.
          defaults={{ name }}
          nameNote={nameNote}
          joinsChannelName={channelName}
          visibilityLocked
          onCreate={async (input) => {
            const created = await create({ data: input });
            onCreated(
              { id: created.agent.id, name: created.agent.displayName || created.agent.name },
              created.startPublished,
            );
            return created;
          }}
        />
      )}
    </div>
  );
}
