/** Text renderers for `coforge channel info|members|join|leave|create|update|lifecycle|
 * add-member|remove-member`. Success text matches Raft 1.0.32's channel formatters verbatim
 * (`raft` renamed to `coforge`, from the Raft 1.0.32 bundle's `formatJoinChannelResult`/
 * `formatLeaveChannelResult`/`formatCreateChannelResult`/`formatUpdateChannelResult`/
 * `formatArchiveChannelResult`/`formatUnarchiveChannelResult`/`formatAddMemberResult`/
 * `formatRemoveMemberResult`/`formatChannelMembers`/`formatChannelInfo`/
 * `channelMemberRoleDetail`), minus the parts of Raft's shape CoForge has no equivalent for
 * (private channels, the `attention` block on leave/remove-member). Every subcommand's `--json`
 * mode prints the response object these functions render, unchanged; see `run()` in
 * `../index.ts`. */

export type ChannelAdminBasis = "server_role" | "channel_role";

export type ChannelCapability =
  | "post"
  | "leave"
  | "add_member"
  | "update"
  | "archive"
  | "unarchive"
  | "remove_member"
  | "manage_roles";

export type ChannelInfoLike = {
  id: string;
  name: string;
  description: string;
  archived: boolean;
  joined: boolean;
  muted: boolean;
  memberCounts: { agents: number; humans: number };
  channelRole?: string;
  channelAdminBasis?: ChannelAdminBasis;
  channelCapabilities: Record<ChannelCapability, boolean>;
  /** Present only when this channel is a Project discussion group; same fields `workspace info
   * --projects` renders, so an Agent can match this channel's Project to that list. */
  project?: {
    id: string;
    name: string;
    slug: string;
    githubFullName?: string;
    githubHtmlUrl?: string;
  };
};

export type ChannelRosterAgentLike = {
  name: string;
  displayName: string;
  description: string;
  serverRole: string;
  channelRole?: string;
  channelAdminBasis?: ChannelAdminBasis;
  status: "online" | "offline" | "unknown";
  activity?: string;
  activityDetail?: string;
};

export type ChannelRosterHumanLike = {
  username: string;
  serverRole: string;
  channelRole?: string;
  channelAdminBasis?: ChannelAdminBasis;
};

/** Raft's `roleLabel`: ` (admin)`/` (owner)`, or nothing for an ordinary member. */
function roleSuffix(role: string): string {
  return role === "admin" || role === "owner" ? ` (${role})` : "";
}

/** Raft's `channelMemberRoleDetail`: ` [server role=<r>, channel role=<r>, admin via=<basis>]`,
 * each part only when present. CoForge's server always populates `serverRole`/`channelRole` for
 * a listed member, so this renderer — not the server — hides the uninformative default
 * (`"member"`), the same convention `roleSuffix` already uses for the plain `(admin)`/`(owner)`
 * tag. */
function channelMemberRoleDetail(member: {
  serverRole?: string;
  channelRole?: string;
  channelAdminBasis?: ChannelAdminBasis;
}): string {
  const details: string[] = [];
  if (member.serverRole && member.serverRole !== "member")
    details.push(`server role=${member.serverRole}`);
  if (member.channelRole && member.channelRole !== "member")
    details.push(`channel role=${member.channelRole}`);
  if (member.channelAdminBasis) details.push(`admin via=${member.channelAdminBasis}`);
  return details.length > 0 ? ` [${details.join(", ")}]` : "";
}

/** Raft's `agentStatusLabel`: the lifecycle alone, or `<lifecycle>; <activity>[: <detail>]`
 * when the Agent is doing something more specific than merely being connected. */
function agentStatusLabel(
  agent: Pick<ChannelRosterAgentLike, "status" | "activity" | "activityDetail">,
): string {
  if (agent.status === "online" && agent.activity)
    return `online; ${agent.activity}${agent.activityDetail ? `: ${agent.activityDetail}` : ""}`;
  return agent.status;
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

export function formatChannelInfo(response: { channel: ChannelInfoLike }): string {
  const channel = response.channel;
  const total = channel.memberCounts.agents + channel.memberCounts.humans;
  const lines = [
    "## Channel",
    "",
    `Channel: ${channel.name}`,
    `ID: ${channel.id}`,
    "Visibility: public",
    `Joined: ${yesNo(channel.joined)}`,
  ];
  // Same "hide the uninformative default" convention as `channelMemberRoleDetail`.
  if (channel.channelRole && channel.channelRole !== "member")
    lines.push(`Channel role: ${channel.channelRole}`);
  if (channel.channelAdminBasis) lines.push(`Channel admin basis: ${channel.channelAdminBasis}`);
  const callableCapabilities = Object.entries(channel.channelCapabilities)
    .filter(([, allowed]) => allowed)
    .map(([capability]) => capability);
  if (callableCapabilities.length > 0)
    lines.push(`Channel capabilities: ${callableCapabilities.join(", ")}`);
  lines.push(
    `Muted: ${yesNo(channel.muted)}`,
    `Archived: ${yesNo(channel.archived)}`,
    `Description: ${channel.description || "(none)"}`,
  );
  // Same rendering as `workspace info --projects`'s project line, so an Agent can match this
  // channel's Project up against that list. Absent for a channel with no bound Project.
  if (channel.project)
    lines.push(
      `Project: ${channel.project.name} (${channel.project.slug})${channel.project.githubFullName ? ` github=${channel.project.githubFullName}` : ""}`,
    );
  lines.push(
    // Always plural, like Raft's formatChannelInfo — never singularized for a count of 1.
    `Members: ${total} (${channel.memberCounts.agents} agents, ${channel.memberCounts.humans} humans)`,
    "",
    `More: coforge channel members "${channel.name}"`,
  );
  return lines.join("\n");
}

/** Raft's `formatChannelMembers`: `  - @name (<status>)<role><channel detail> — <description>`
 * for an Agent (no "self" tag; Raft has none), `  - @username<role><channel detail>` for a
 * human. */
export function formatChannelMembers(response: {
  target: string;
  agents: ChannelRosterAgentLike[];
  humans: ChannelRosterHumanLike[];
}): string {
  const lines = [
    "## Channel Members",
    "",
    `Channel: ${response.target}`,
    "Members means join/post authority for this surface.",
    "",
    "### Agents",
    "Server and stored channel roles are shown separately when available.",
  ];
  if (response.agents.length === 0) lines.push("  (none)");
  else
    for (const agent of response.agents) {
      const status = `(${agentStatusLabel(agent)})`;
      const role = roleSuffix(agent.serverRole);
      const detail = channelMemberRoleDetail(agent);
      lines.push(
        agent.description
          ? `  - @${agent.name} ${status}${role}${detail} — ${agent.description}`
          : `  - @${agent.name} ${status}${role}${detail}`,
      );
    }
  lines.push(
    "",
    "### Humans",
    "Server and stored channel roles are shown separately when available.",
  );
  if (response.humans.length === 0) lines.push("  (none)");
  else
    for (const human of response.humans)
      lines.push(
        `  - @${human.username}${roleSuffix(human.serverRole)}${channelMemberRoleDetail(human)}`,
      );
  return lines.join("\n");
}

/** Raft's `formatJoinChannelResult`/`formatAlreadyJoined`. */
export function formatChannelJoin(response: { target: string; alreadyJoined: boolean }): string {
  if (response.alreadyJoined) return `Already joined ${response.target}.`;
  return [
    `Joined ${response.target}. You can now send messages there and receive ordinary channel delivery.`,
    "Still arrives:",
    "- Personal @mentions still reach you even if you later mute ordinary channel updates.",
    "- Threads you started or follow stay followed even if you later mute this channel.",
  ].join("\n");
}

/** Raft's `formatLeaveChannelResult`/`formatAlreadyNotJoined`. */
export function formatChannelLeave(response: { target: string; wasMember: boolean }): string {
  if (!response.wasMember) return `Already not joined in ${response.target}.`;
  return `Left ${response.target}. You can still inspect visible public channel history there, but you can no longer send or receive ordinary channel delivery until you join the public channel again or a human re-adds you to a private channel.`;
}

/** Raft's `formatCreateChannelResult`; CoForge has no private channels, so visibility is
 * always "(public)". */
export function formatChannelCreate(response: { channel: { name: string } }): string {
  return `Created ${response.channel.name} (public). You are joined and can send messages there.`;
}

/** Raft's `formatUpdateChannelResult` — not the info block. */
export function formatChannelUpdate(response: { channel: { name: string } }): string {
  return `Updated ${response.channel.name} (public).`;
}

/** Raft's `formatArchiveChannelResult`/`formatUnarchiveChannelResult`. */
export function formatChannelArchive(response: { target: string; archived: boolean }): string {
  return response.archived
    ? `Archived ${response.target}. The channel is read-only until unarchived.`
    : `Unarchived ${response.target}. Messages and other writes are enabled again.`;
}

/** Raft's `formatAddMemberResult`. */
export function formatChannelAddMember(response: {
  target: string;
  member: { kind: "user" | "agent"; handle: string };
  alreadyMember: boolean;
}): string {
  if (response.alreadyMember) return `${response.member.handle} is already in ${response.target}.`;
  return `Added ${response.member.handle} to ${response.target} as ${
    response.member.kind === "agent" ? "an agent" : "a user"
  }.`;
}

/** Raft's `formatRemoveMemberResult`. The route's `{ target, removed: true, wasMember }`
 * response carries no member handle; the CLI already knows which `--user`/`--agent` it asked
 * to remove. */
export function formatChannelRemoveMember(
  target: string,
  handle: string,
  wasMember: boolean,
): string {
  if (!wasMember) return `${handle} was not in ${target}.`;
  return `Removed ${handle} from ${target}.`;
}
