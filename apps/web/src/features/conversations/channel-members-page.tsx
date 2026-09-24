import { memo, useCallback, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Button as AriaButton,
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
import { Checkbox } from "#src/components/base/checkbox/checkbox";
import { Input } from "#src/components/base/input/input";
import { AgentDisplayAvatar } from "#src/features/agents/agent-activity-avatar";
import { agentDisplay } from "#src/features/agents/agent-activity-presentation";
import { useAgentDisplays } from "#src/features/agents/workspace-agents-realtime";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";
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
 * add view, where a member picks Workspace Agents and people to add. It reads and updates the
 * same query as the panel's Members strip.
 */
export function ChannelMembersPage({
  channelId,
  channelName,
  viewerHandle,
  view,
  onViewChange,
  onOpenAgentProfile,
}: {
  channelId: string;
  channelName: string;
  /** The viewer's own username: their row offers no role change. */
  viewerHandle?: string;
  view: ChannelMembersView;
  onViewChange: (view: ChannelMembersView) => void;
  onOpenAgentProfile?: (agentId: string) => void;
}) {
  const members = useChannelMembers(channelId);
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
      onOpenAgentProfile={onOpenAgentProfile}
    />
  );
}

function MembersRoster({
  channelId,
  channelName,
  viewerHandle,
  data,
  onAdd,
  onOpenAgentProfile,
}: {
  channelId: string;
  channelName: string;
  viewerHandle?: string;
  data: ChannelMembers;
  onAdd: () => void;
  onOpenAgentProfile?: (agentId: string) => void;
}) {
  const queryClient = useQueryClient();
  const setRole = useServerFn(setPublicChannelMemberRole);
  const displays = useAgentDisplays();
  const [search, setSearch] = useState("");
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
  const openAgentProfile = onOpenAgentProfile;

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
        onOpenAgentProfile={openAgentProfile}
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
          onChange={setSearch}
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
}: {
  member: Member;
  display: AgentDisplaySnapshot | undefined;
  canChangeRole: boolean;
  roleBusy: boolean;
  canRemove: boolean;
  onToggleRole: (member: Member) => void;
  onRemove: (member: Member) => void;
  onOpenAgentProfile?: (agentId: string) => void;
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
      {member.kind === "agent" && onOpenAgentProfile ? (
        <AriaButton
          aria-label={m.agent_open_profile({ name: member.displayName })}
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
  data,
  onDone,
}: {
  channelId: string;
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
  const query = search.trim().replace(/^@/, "").toLowerCase();
  const shown = useMemo(
    () => candidates.filter((entry) => matches(query, entry.displayName, entry.handle)),
    [candidates, query],
  );
  const shownAgents = shown.filter((entry) => entry.kind === "agent");
  const shownHumans = shown.filter((entry) => entry.kind === "user");

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
    return (
      <li key={entry.key} className="px-4 py-2 md:px-6">
        <Checkbox
          isSelected={selected.has(entry.key)}
          isDisabled={busy}
          onChange={(on) => toggle(entry.key, on)}
          label={
            <span className="flex min-w-0 items-center gap-2">
              <Avatar
                size="xs"
                alt=""
                src={entry.avatarUrl ?? undefined}
                initials={avatarInitial(entry.displayName)}
                contentClassName={avatarToneClassName(entry.displayName)}
              />
              <span className="truncate">{entry.displayName}</span>
            </span>
          }
          hint={entry.description?.trim() || undefined}
        />
      </li>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-3 border-b border-secondary px-4 py-3 md:px-6">
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
            {m.channel_members_no_matches({ query: search.trim() })}
          </p>
        )}
      </div>
      <div className="flex shrink-0 flex-col gap-2 border-t border-secondary px-4 py-3 md:px-6">
        {error && (
          <p role="alert" className="text-sm text-error-primary">
            {error}
          </p>
        )}
        <Button
          iconLeading={Plus}
          className="w-full"
          isDisabled={busy || selected.size === 0}
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
