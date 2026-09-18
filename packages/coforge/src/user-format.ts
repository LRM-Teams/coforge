import type { AgentProfileView, AgentUserInfoResponse } from "@lrm/coforge-sdk/agent";

/** `coforge user info <name>`: narrow visible facts for a human or Agent, its visible channel
 * memberships and, for an Agent, its live status/availability. */
export function formatUserInfo(response: AgentUserInfoResponse): string {
  const { user, memberships } = response;
  const lines = ["## User", ""];
  lines.push(`Username: @${user.name}`);
  lines.push(`Kind: ${user.kind}`);
  lines.push(`Display name: ${user.displayName}`);
  if (user.role) lines.push(`Role: ${user.role}`);
  if (user.description) lines.push(`Description: ${user.description}`);
  if (user.kind === "agent") {
    if (user.status) lines.push(`Status: ${user.status}`);
    if (user.computerName) lines.push(`Computer: ${user.computerName}`);
    if (user.runtime) lines.push(`Provider: ${user.runtime}`);
    if (user.model) lines.push(`Model: ${user.model}`);
    if (user.availability) lines.push(`Availability: ${user.availability}`);
  }
  if (user.isSelf) lines.push("Self: yes");
  lines.push("");
  lines.push("### Visible Channel Memberships");
  if (memberships.length === 0) lines.push("(none)");
  else for (const membership of memberships) lines.push(`- ${membership.channel}`);
  return lines.join("\n");
}

/** `coforge profile show [<target>]` and `coforge profile update`: both return the same
 * discriminated profile view, so they share one renderer. */
export function formatProfile(response: { profile: AgentProfileView }): string {
  const { profile } = response;
  const lines = ["## Profile", ""];
  lines.push(`Username: @${profile.name}`);
  lines.push(`Kind: ${profile.kind}`);
  lines.push(`Display name: ${profile.displayName}`);
  if (profile.description) lines.push(`Description: ${profile.description}`);
  if (profile.role) lines.push(`Role: ${profile.role}`);
  if (profile.kind === "agent") {
    lines.push(`Status: ${profile.status}`);
    if (profile.computerName) lines.push(`Computer: ${profile.computerName}`);
    if (profile.runtime) lines.push(`Provider: ${profile.runtime}`);
    if (profile.model) lines.push(`Model: ${profile.model}`);
    if (profile.availability) lines.push(`Availability: ${profile.availability}`);
  }
  if (profile.isSelf) lines.push("Self: yes");
  lines.push("");
  if (profile.kind === "human") {
    lines.push("### Created Agents");
    if (profile.createdAgents.length === 0) lines.push("(none)");
    else
      for (const agent of profile.createdAgents) lines.push(`- @${agent.name} (${agent.status})`);
  } else {
    lines.push(
      profile.creator
        ? `Creator: @${profile.creator.name} (${profile.creator.displayName})`
        : "Creator: (unknown)",
    );
  }
  return lines.join("\n");
}
