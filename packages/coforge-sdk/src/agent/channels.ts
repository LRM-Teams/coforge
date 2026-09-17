/** Channel lifecycle/roster response shapes for `agentApiRoutes.cloud.channels`. */

/** Computed, never stored: `server_role` when the actor's Workspace/Agent server role is
 * owner/admin; otherwise `channel_role` when its own membership's stored `channelRole` is
 * `admin`; otherwise absent. `server_role` wins when both apply (ADR 0030). */
export type AgentChannelAdminBasis = "server_role" | "channel_role";

export const AGENT_CHANNEL_CAPABILITIES = [
  "post",
  "leave",
  "add_member",
  "update",
  "archive",
  "unarchive",
  "remove_member",
  "manage_roles",
] as const;
export type AgentChannelCapability = (typeof AGENT_CHANNEL_CAPABILITIES)[number];
export type AgentChannelCapabilities = Record<AgentChannelCapability, boolean>;

export type AgentChannelInfo = {
  id: string;
  name: string;
  description: string;
  archived: boolean;
  joined: boolean;
  muted: boolean;
  memberCounts: { agents: number; humans: number };
  /** Present only while the acting Agent is an active member (its own stored
   * `ConversationMember.channelRole`); absent for a non-member. */
  channelRole?: string;
  /** Present only when the acting Agent has channel-admin authority here, either basis. */
  channelAdminBasis?: AgentChannelAdminBasis;
  /** Every capability name; only the ones this Agent may currently invoke are `true`. */
  channelCapabilities: AgentChannelCapabilities;
  /** Present only when this channel is a Project discussion group (ADR 0026) for a Project the
   * Agent's own Workspace owns. Field names and source match `workspace info --projects`
   * (`WorkspaceInfoProject`), so an Agent can match the two surfaces up. Absent on an older
   * server that predates this field. */
  project?: {
    id: string;
    name: string;
    slug: string;
    githubFullName?: string;
    githubHtmlUrl?: string;
  };
};

/** Response for `channel info` (GET /api/agent/v1/channels/:channel) and `channel update`
 * (PATCH .../:channel), which returns the same info shape after applying its patch. */
export type AgentChannelInfoResponse = {
  protocolMajor: 1;
  requestId: string;
  channel: AgentChannelInfo;
};

export type AgentChannelRosterAgent = {
  name: string;
  displayName: string;
  description: string;
  /** The member's own server role (a rename of this field's former `role` name, matching
   * Raft's `serverRole`; see ADR 0030). */
  serverRole: string;
  /** Present for a `#channel` roster (every listed member is active there); absent for the
   * `@user` DM roster, which has no channel-role concept. */
  channelRole?: string;
  channelAdminBasis?: AgentChannelAdminBasis;
  /** True for the calling Agent's own roster row. Kept in the response for callers that need
   * it, but not surfaced by the CLI's text renderer — Raft's `formatChannelMembers` has no
   * self tag. */
  self: boolean;
  /** Live lifecycle; "unknown" only when the server has no data (no Computer, or the display
   * snapshot itself could not be read). */
  status: "online" | "offline" | "unknown";
  /** Present only when `status` is "online" and the Agent is doing something more specific
   * than merely being connected (Raft's `working`/`thinking`/`error`). */
  activity?: string;
  activityDetail?: string;
};

export type AgentChannelRosterHuman = {
  username: string;
  serverRole: string;
  channelRole?: string;
  channelAdminBasis?: AgentChannelAdminBasis;
};

/** Response for `channel members` (GET /api/agent/v1/channels/:channel/members). */
export type AgentChannelMembersResponse = {
  protocolMajor: 1;
  requestId: string;
  target: string;
  agents: AgentChannelRosterAgent[];
  humans: AgentChannelRosterHuman[];
};

/** Response for `channel join`. `alreadyJoined` distinguishes Raft's "Already joined #x." text
 * from the full join confirmation. */
export type AgentChannelJoinResponse = {
  protocolMajor: 1;
  requestId: string;
  target: string;
  joined: true;
  alreadyJoined: boolean;
};

/** Response for `channel leave`. `wasMember` distinguishes Raft's "Already not joined in #x."
 * text from the full leave confirmation. */
export type AgentChannelLeaveResponse = {
  protocolMajor: 1;
  requestId: string;
  target: string;
  joined: false;
  wasMember: boolean;
};

/** Response for `channel create` (POST /api/agent/v1/channels). */
export type AgentChannelCreateResponse = {
  protocolMajor: 1;
  requestId: string;
  target: string;
  channel: { id: string; name: string; description: string };
};

/** Response for `channel lifecycle archive|unarchive`. */
export type AgentChannelArchiveResponse = {
  protocolMajor: 1;
  requestId: string;
  target: string;
  archived: boolean;
};

/** Response for `channel add-member`. `alreadyMember` distinguishes Raft's "@h is already in
 * #x." text from the full add-member confirmation. */
export type AgentChannelAddMemberResponse = {
  protocolMajor: 1;
  requestId: string;
  target: string;
  member: { kind: "user" | "agent"; handle: string };
  added: true;
  alreadyMember: boolean;
};

/** Response for `channel remove-member`. `wasMember` distinguishes Raft's "@h was not in #x."
 * text from the full remove-member confirmation. */
export type AgentChannelRemoveMemberResponse = {
  protocolMajor: 1;
  requestId: string;
  target: string;
  removed: true;
  wasMember: boolean;
};
