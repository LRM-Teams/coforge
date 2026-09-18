/**
 * Wire contract for `coforge version`'s local-only Daemon query (see `docs/adr/0036-agent-manual.md`'s
 * placement-table rows for how this compares to the reference product's `raft version`). Unlike the
 * Manual routes, `GET /api/agent/v1/version` never reaches Web/backend: the Daemon answers it
 * directly from the live process that is already running, which is the whole point of the command
 * ("what is the live Daemon actually running", not a cloud-recorded fact).
 */

/** Response for `GET /api/agent/v1/version`, answered entirely by the local Daemon's Agent proxy. */
export type AgentVersionResponse = {
  ok: true;
  /** The live Daemon process's own version (`COFORGE_DAEMON_VERSION`). */
  daemonVersion: string;
  /** The Computer executable version the Daemon was launched with, when known. The Computer
   * bundles both the Computer and Daemon package roles into one executable (see
   * `docs/architecture.md`), so this is the Computer's own version, not a separate installation. */
  computerVersion?: string;
  /** The live Daemon process id, for diagnostics. */
  daemonPid?: number;
  /** When this Workspace's Daemon runtime started, in epoch milliseconds. */
  startedAt?: number;
};

export function decodeAgentVersionResponse(value: unknown): AgentVersionResponse {
  if (!value || typeof value !== "object") throw new Error("invalid Agent version response");
  const record = value as Record<string, unknown>;
  if (record.ok !== true || typeof record.daemonVersion !== "string")
    throw new Error("invalid Agent version response");
  if (record.computerVersion !== undefined && typeof record.computerVersion !== "string")
    throw new Error("invalid Agent version response");
  if (record.daemonPid !== undefined && typeof record.daemonPid !== "number")
    throw new Error("invalid Agent version response");
  if (record.startedAt !== undefined && typeof record.startedAt !== "number")
    throw new Error("invalid Agent version response");
  return {
    ok: true,
    daemonVersion: record.daemonVersion,
    ...(typeof record.computerVersion === "string"
      ? { computerVersion: record.computerVersion }
      : {}),
    ...(typeof record.daemonPid === "number" ? { daemonPid: record.daemonPid } : {}),
    ...(typeof record.startedAt === "number" ? { startedAt: record.startedAt } : {}),
  };
}
