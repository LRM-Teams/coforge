/**
 * The single owner of every internal RPC method name — the cloud ↔ Computer/Daemon/Agent wire
 * protocol in `@lrm/coforge-sdk/internal`.
 *
 * Names follow `<scope>:v<major>:<domain>:<action>[_result]` (see docs/architecture.md). `<scope>`
 * is the owning surface (`daemon` | `agent` | `computer` | `workspace`); `v<major>` is the
 * RPC-surface version and must equal the envelope `protocolMajor`; `<domain>` is a singular
 * resource noun; `<action>` is a single verb; a reply is the request name plus `_result`.
 *
 * No other module may hard-code a method name as a string literal. The per-feature `*_METHOD`
 * constants re-export the entries below so call sites keep their readable names, and
 * `rpc-method-literal-scan.test.ts` fails the build if a method name leaks back out as a literal.
 *
 * The local CLI ↔ resident-daemon IPC method names (`LOCAL_RPC_METHODS`) are a separate protocol
 * and do not live here.
 *
 * `LEGACY_RPC_METHOD_NAMES` below holds the pre-rename spellings of the same vocabulary for the
 * upgrade window; the local IPC names are unaffected by it too.
 */
export const RPC_METHODS = {
  computerRegister: "computer:v1:register",
  workspaceList: "workspace:v1:list",
  workspaceGet: "workspace:v1:get",
  daemonRuntimeReady: "daemon:v1:runtime:ready",
  daemonConnectionStatus: "daemon:v1:connection:status",
  daemonCodeAgentsUpdate: "daemon:v1:provider:inventory_update",
  daemonUsageScan: "daemon:v1:provider:usage_scan",
  daemonUsageScanResult: "daemon:v1:provider:usage_scan_result",
  computerRestart: "computer:v1:lifecycle:restart",
  computerUpgrade: "computer:v1:lifecycle:upgrade",
  computerUpgradeResult: "computer:v1:lifecycle:upgrade_result",
  agentStart: "agent:v1:start",
  agentStop: "agent:v1:stop",
  agentActivityProbe: "agent:v1:activity:probe",
  agentContextScan: "agent:v1:context:scan",
  agentContextScanResult: "agent:v1:context:scan_result",
  agentMessage: "agent:v1:message:deliver",
  agentMessageAck: "agent:v1:message:ack",
  agentChannelMute: "agent:v1:channel:mute",
  agentChannelUnmute: "agent:v1:channel:unmute",
  agentThreadUnfollow: "agent:v1:thread:unfollow",
  agentStatus: "agent:v1:status:get",
  agentActivity: "agent:v1:activity:get",
  agentSession: "agent:v1:session:get",
  agentSessionInvalidate: "agent:v1:session:invalidate",
  agentContextUsage: "agent:v1:context:usage",
  agentWorkspaceInfo: "agent:v1:workspace:info",
  agentWorkspaceReset: "agent:v1:workspace:reset",
  agentControlResult: "agent:v1:control:result",
  agentSkillsList: "agent:v1:skills:list",
  agentSkillsListResult: "agent:v1:skills:list_result",
  agentWorkspaceFilesList: "agent:v1:workspace_files:list",
  agentWorkspaceFilesListResult: "agent:v1:workspace_files:list_result",
  agentWorkspaceFileRead: "agent:v1:workspace_files:read",
  agentWorkspaceFileReadResult: "agent:v1:workspace_files:read_result",
  agentReminder: "agent:v1:reminder:deliver",
  reminderFire: "reminder:v1:fire",
  reminderSnapshot: "reminder:v1:snapshot",
  agentTask: "agent:v1:task:get",
  agentWeeklyReport: "agent:v1:weekly_report:get",
} as const;

/**
 * The pre-rename spelling of every method, keyed by the current `RPC_METHODS` entry it now belongs
 * to. PR #459 renamed the whole vocabulary at once, so every installed Computer still speaks these
 * names: a Daemon that has not been upgraded yet sends them, and a Daemon that has not been
 * upgraded yet rejects an `AgentMessageDelivery` whose discriminator is not the old `agent:deliver`
 * spelling. The cloud therefore keeps accepting the names below at its RPC boundary
 * (`currentRpcMethodName`), and keeps emitting the delivery/ACK discriminator they carry
 * (`codec.ts`).
 *
 * This is an upgrade window, not a second vocabulary: delete an entry once no installed Computer
 * can still send it, and delete the table once it is empty. The per-feature `*_METHOD` constants
 * stay the current spelling, so call sites never name a legacy method.
 *
 * TODO(legacy-rpc-methods): remove this table (and the dual-spelling delivery/ACK tolerance in
 * `codec.ts` plus the alias lookup in the Web RPC handler) once every Computer has been upgraded.
 */
export const LEGACY_RPC_METHOD_NAMES = {
  computerRegister: "computer:register",
  workspaceList: "workspace:list",
  workspaceGet: "workspace:get",
  daemonRuntimeReady: "daemon:runtime_ready",
  daemonConnectionStatus: "daemon:connection_status",
  daemonCodeAgentsUpdate: "daemon:code_agents_update",
  daemonUsageScan: "daemon:usage_scan",
  daemonUsageScanResult: "daemon:usage_scan_result",
  computerRestart: "computer:restart",
  computerUpgrade: "computer:upgrade",
  computerUpgradeResult: "computer:upgrade_result",
  agentStart: "agent:start",
  agentStop: "agent:stop",
  agentActivityProbe: "agent:activity_probe",
  agentContextScan: "agent:context_scan",
  agentContextScanResult: "agent:context_scan_result",
  agentMessage: "agent:deliver",
  agentMessageAck: "agent:deliver:ack",
  agentChannelMute: "agent:channel:mute",
  agentChannelUnmute: "agent:channel:unmute",
  agentThreadUnfollow: "agent:thread:unfollow",
  agentStatus: "agent:status",
  agentActivity: "agent:activity",
  agentSession: "agent:session",
  agentSessionInvalidate: "agent:session:invalidate",
  agentContextUsage: "agent:context:usage",
  agentWorkspaceInfo: "agent:workspace:info",
  agentWorkspaceReset: "agent:reset-workspace",
  agentControlResult: "agent:control:result",
  agentSkillsList: "agent:skills:list",
  agentSkillsListResult: "agent:skills:list_result",
  agentWorkspaceFilesList: "agent:workspace_files:list",
  agentWorkspaceFilesListResult: "agent:workspace_files:list_result",
  agentWorkspaceFileRead: "agent:workspace_files:read",
  agentWorkspaceFileReadResult: "agent:workspace_files:read_result",
  agentReminder: "agent:reminder",
  reminderFire: "reminder:fire",
  reminderSnapshot: "reminder:snapshot",
  agentTask: "agent:task",
  agentWeeklyReport: "agent:weekly-report",
} as const satisfies Partial<Record<keyof typeof RPC_METHODS, string>>;

const CURRENT_RPC_METHOD_NAMES: ReadonlyMap<string, string> = new Map(
  (Object.keys(LEGACY_RPC_METHOD_NAMES) as Array<keyof typeof RPC_METHODS>).map((name) => [
    LEGACY_RPC_METHOD_NAMES[name],
    RPC_METHODS[name],
  ]),
);

/** The current name a pre-rename wire method stands for; `undefined` for every other name. */
export function currentRpcMethodName(method: string): string | undefined {
  return CURRENT_RPC_METHOD_NAMES.get(method);
}
