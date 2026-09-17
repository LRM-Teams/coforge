/** Channel lifecycle/roster response shapes for `agentApiRoutes.cloud.channels`. */

export type AgentChannelInfo = {
  id: string;
  name: string;
  description: string;
  archived: boolean;
  joined: boolean;
  muted: boolean;
  memberCounts: { agents: number; humans: number };
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
  role: string;
  self: boolean;
  /** Live lifecycle; "unknown" only when the server has no data (no Computer, or the display
   * snapshot itself could not be read). */
  status: "online" | "offline" | "unknown";
  /** Present only when `status` is "online" and the Agent is doing something more specific
   * than merely being connected (Raft's `working`/`thinking`/`error`). */
  activity?: string;
  activityDetail?: string;
};

export type AgentChannelRosterHuman = { username: string; role: string };

/** Response for `channel members` (GET /api/agent/v1/channels/:channel/members). */
export type AgentChannelMembersResponse = {
  protocolMajor: 1;
  requestId: string;
  target: string;
  agents: AgentChannelRosterAgent[];
  humans: AgentChannelRosterHuman[];
};

/** Response for `channel join`/`channel leave`. */
export type AgentChannelJoinResponse = {
  protocolMajor: 1;
  requestId: string;
  target: string;
  joined: boolean;
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

/** Response for `channel add-member`. */
export type AgentChannelAddMemberResponse = {
  protocolMajor: 1;
  requestId: string;
  target: string;
  member: { kind: "user" | "agent"; handle: string };
  added: true;
};

/** Response for `channel remove-member`. */
export type AgentChannelRemoveMemberResponse = {
  protocolMajor: 1;
  requestId: string;
  target: string;
  removed: true;
};
