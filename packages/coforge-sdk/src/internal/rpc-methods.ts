/**
 * The single owner of every internal RPC method name — the cloud ↔ Computer/Daemon/Agent wire
 * protocol in `@lrm/coforge-sdk/internal`.
 *
 * Names follow `<scope>:v<major>:<domain>:<action>[_result]` (see docs/architecture.md). `<scope>`
 * is the owning surface (`daemon` | `agent` | `computer` | `workspace` | `reminder`); `v<major>` is
 * the RPC-surface version and must equal the envelope `protocolMajor`; `<domain>` is a singular
 * resource noun; `<action>` is a single verb; a reply is the request name plus `_result`.
 *
 * The `<scope>` is also the RPC namespace, and Centrifugo proxies a call only when that namespace
 * is enabled for RPC in its configuration (`rpc.namespaces` in `infra/centrifugo/config.yaml` and
 * `infra/staging/centrifugo/config.yaml`). An unlisted namespace is refused with
 * `104 method not found` *before* the backend sees the call — the backend's own answer to an
 * unknown method is `404 unknown RPC method`. The refusal therefore looks like a server that does
 * not know the method at all, while everything downstream (retries, catch-up, the reminder that
 * never fires) fails quietly. `rpc-method-namespace.test.ts` fails the build when the two lists
 * drift apart.
 *
 * No other module may hard-code a method name as a string literal. The per-feature `*_METHOD`
 * constants re-export the entries below so call sites keep their readable names, and
 * `rpc-method-literal-scan.test.ts` fails the build if a method name leaks back out as a literal.
 *
 * The local CLI ↔ resident-daemon IPC method names (`LOCAL_RPC_METHODS`) are a separate protocol
 * and do not live here.
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
  daemonModelRefresh: "daemon:v1:provider:model_refresh",
  daemonModelRefreshResult: "daemon:v1:provider:model_refresh_result",
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
  agentWeeklyReport: "agent:v1:weekly_report:get",
} as const;
