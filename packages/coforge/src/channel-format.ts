/** Text renderers for `coforge channel info|members|join|leave|create|update|lifecycle|
 * add-member|remove-member`. Success text matches Raft 1.0.32's channel formatters verbatim
 * (`raft` renamed to `coforge`, from the Raft 1.0.32 bundle's `formatJoinChannelResult`/
 * `formatLeaveChannelResult`/`formatCreateChannelResult`/`formatUpdateChannelResult`/
 * `formatArchiveChannelResult`/`formatUnarchiveChannelResult`/`formatAddMemberResult`/
 * `formatRemoveMemberResult`/`formatChannelMembers`/`formatChannelInfo`), minus the parts of
 * Raft's shape CoForge has no equivalent for (private channels, channel-level roles, the
 * `attention` block on leave/remove-member). Every subcommand's `--json` mode prints the
 * response object these functions render, unchanged; see `run()` in `../index.ts`. */

export type ChannelInfoLike = {
  id: string;
  name: string;
  description: string;
  archived: boolean;
  joined: boolean;
  muted: boolean;
  memberCounts: { agents: number; humans: number };
};

export type ChannelRosterAgentLike = {
  name: string;
  displayName: string;
  description: string;
  role: string;
  status: "online" | "offline" | "unknown";
  activity?: string;
  activityDetail?: string;
};

export type ChannelRosterHumanLike = { username: string; role: string };

/** Raft's `roleLabel`: ` (admin)`/` (owner)`, or nothing for an ordinary member. */
function roleSuffix(role: string): string {
  return role === "admin" || role === "owner" ? ` (${role})` : "";
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
  return [
    "## Channel",
    "",
    `Channel: ${channel.name}`,
    `ID: ${channel.id}`,
    "Visibility: public",
    `Joined: ${yesNo(channel.joined)}`,
    `Muted: ${yesNo(channel.muted)}`,
    `Archived: ${yesNo(channel.archived)}`,
    `Description: ${channel.description || "(none)"}`,
    // Always plural, like Raft's formatChannelInfo — never singularized for a count of 1.
    `Members: ${total} (${channel.memberCounts.agents} agents, ${channel.memberCounts.humans} humans)`,
    "",
    `More: coforge channel members "${channel.name}"`,
  ].join("\n");
}

/** Raft's `formatChannelMembers`: `  - @name (<status>)<role> — <description>` for an Agent
 * (no "self" tag; Raft has none), `  - @username<role>` for a human. */
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
  ];
  if (response.agents.length === 0) lines.push("  (none)");
  else
    for (const agent of response.agents) {
      const status = `(${agentStatusLabel(agent)})`;
      const role = roleSuffix(agent.role);
      lines.push(
        agent.description
          ? `  - @${agent.name} ${status}${role} — ${agent.description}`
          : `  - @${agent.name} ${status}${role}`,
      );
    }
  lines.push("", "### Humans");
  if (response.humans.length === 0) lines.push("  (none)");
  else
    for (const human of response.humans)
      lines.push(`  - @${human.username}${roleSuffix(human.role)}`);
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
