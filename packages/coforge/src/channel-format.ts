/** Text renderers for `coforge channel info|members|join|leave|create|update|lifecycle|
 * add-member|remove-member`. Every subcommand's `--json` mode prints the response object these
 * functions render, unchanged; see `run()` in `../index.ts`. */

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
  self: boolean;
};

export type ChannelRosterHumanLike = { username: string; role: string };

/** `(self, admin)` / `(admin)` / `(self)` / nothing — `member` never prints a role marker. */
function roleAndSelfSuffix(role: string, self: boolean): string {
  const parts: string[] = [];
  if (self) parts.push("self");
  if (role === "admin" || role === "owner") parts.push(role);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

export function formatChannelInfo(response: { channel: ChannelInfoLike }): string {
  const channel = response.channel;
  const total = channel.memberCounts.agents + channel.memberCounts.humans;
  const agentsNoun = channel.memberCounts.agents === 1 ? "agent" : "agents";
  const humansNoun = channel.memberCounts.humans === 1 ? "human" : "humans";
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
    `Members: ${total} (${channel.memberCounts.agents} ${agentsNoun}, ${channel.memberCounts.humans} ${humansNoun})`,
    "",
    `More: coforge channel members "${channel.name}"`,
  ].join("\n");
}

/** `channel update` returns the same info shape as `channel info`, after applying its patch. */
export const formatChannelUpdate = formatChannelInfo;

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
    for (const agent of response.agents)
      lines.push(
        `  - @${agent.name}${roleAndSelfSuffix(agent.role, agent.self)}${
          agent.description ? ` — ${agent.description}` : ""
        }`,
      );
  lines.push("", "### Humans");
  if (response.humans.length === 0) lines.push("  (none)");
  else
    for (const human of response.humans)
      lines.push(`  - @${human.username}${roleAndSelfSuffix(human.role, false)}`);
  return lines.join("\n");
}

export function formatChannelJoin(response: { target: string }): string {
  return `Joined ${response.target}.`;
}

export function formatChannelLeave(response: { target: string }): string {
  return `Left ${response.target}.`;
}

export function formatChannelCreate(response: { channel: { id: string; name: string } }): string {
  return `Created ${response.channel.name}. ID: ${response.channel.id}`;
}

export function formatChannelArchive(response: { target: string; archived: boolean }): string {
  return response.archived ? `Archived ${response.target}.` : `Unarchived ${response.target}.`;
}

export function formatChannelAddMember(response: {
  target: string;
  member: { handle: string };
}): string {
  return `Added ${response.member.handle} to ${response.target}.`;
}

/** `channel remove-member`'s response carries no member handle (`{ target, removed: true }`);
 * the CLI already knows which `--user`/`--agent` it asked to remove. */
export function formatChannelRemoveMember(target: string, handle: string): string {
  return `Removed ${handle} from ${target}.`;
}
