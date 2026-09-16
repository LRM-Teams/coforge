import { parseActivityEntries, type ActivityTrajectoryEntry } from "./activity-entries";

export type AgentActivityKind = "online" | "working" | "thinking" | "error" | "offline";

/** Cloud-authored display projection, separate from Daemon process/Activity facts. */
export type AgentDisplaySnapshot = {
  protocolMajor: 1;
  workspaceId: string;
  computerId: string;
  agentId: string;
  revision: number;
  activityKind: AgentActivityKind;
  detailKind: string;
  detail: string;
  entries: ActivityTrajectoryEntry[];
  /** The cloud must be queried again at this deadline; it is not a client reducer rule. */
  expiresAt: number | null;
};

const activityKinds = new Set<AgentActivityKind>([
  "online",
  "working",
  "thinking",
  "error",
  "offline",
]);

/** Parses the cloud-authored browser display protocol at its public boundary. */
export function parseAgentDisplaySnapshot(data: unknown): AgentDisplaySnapshot {
  const value =
    data instanceof Uint8Array ? (JSON.parse(new TextDecoder().decode(data)) as unknown) : data;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid Agent display snapshot");
  const item = value as Record<string, unknown>;
  const nonempty = (field: unknown) => typeof field === "string" && field.length > 0;
  const bounded = (field: unknown, maximum: number) =>
    typeof field === "string" && [...field].length <= maximum;
  if (
    item.protocolMajor !== 1 ||
    !nonempty(item.workspaceId) ||
    !nonempty(item.computerId) ||
    !nonempty(item.agentId) ||
    !Number.isSafeInteger(item.revision) ||
    (item.revision as number) < 1 ||
    !activityKinds.has(item.activityKind as AgentActivityKind) ||
    !bounded(item.detailKind, 128) ||
    !bounded(item.detail, 512) ||
    (item.expiresAt !== null &&
      (typeof item.expiresAt !== "number" ||
        !Number.isFinite(item.expiresAt) ||
        item.expiresAt <= 0)) ||
    (item.activityKind === "offline" ? item.expiresAt !== null : item.expiresAt === null)
  )
    throw new Error("invalid Agent display snapshot");
  return {
    protocolMajor: 1,
    workspaceId: item.workspaceId,
    computerId: item.computerId,
    agentId: item.agentId,
    revision: item.revision,
    activityKind: item.activityKind,
    detailKind: item.detailKind,
    detail: item.detail,
    entries: parseActivityEntries(item.entries),
    expiresAt: item.expiresAt,
  } as AgentDisplaySnapshot;
}
