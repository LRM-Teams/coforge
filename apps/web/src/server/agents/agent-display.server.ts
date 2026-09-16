import { RedisClient } from "bun";
import type { AgentActivity, AgentStatus } from "@lrm/coforge-sdk/internal";
import {
  AGENT_ACTIVITY_DETAIL_KIND,
  parseAgentDisplaySnapshot,
  type AgentActivityKind,
  type AgentDisplaySnapshot,
} from "@lrm/coforge-sdk/internal";
import { AGENT_STATUS_LEASE_MS } from "./agent-status.server";

// 90s: 1.5x the daemon's 60s busy heartbeat (ACTIVITY_HEARTBEAT_MS), the same
// margin AGENT_STATUS_LEASE_MS keeps over AGENT_STATUS_REFRESH_MS. A silent
// turn stays visibly working/thinking as long as the heartbeat keeps landing.
const WORKING_LEASE_MS = 90_000;

// A single fleet-wide sorted set (not scoped under one Agent's key prefix,
// since AgentActivitySweep walks it across every Workspace/Computer/Agent):
// member `<workspaceId>:<computerId>:<agentId>`, score the busy activity's
// expiresAt. OBSERVE_ACTIVITY/OBSERVE_STATUS keep it in sync so the sweep
// never has to scan Agent state directly to find stale busy leases.
const LEASES_KEY = "coforge:agent-display:activity-leases";

// ADR 0021: busy-but-filler detail kinds. Like runtime_progress, these only
// renew the display lease; they carry no content worth showing or keeping.
export const LIVENESS_ONLY_DETAIL_KINDS: ReadonlySet<string> = new Set([
  AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_PROGRESS,
  AGENT_ACTIVITY_DETAIL_KIND.TOOL_END,
  AGENT_ACTIVITY_DETAIL_KIND.THINKING_END,
  AGENT_ACTIVITY_DETAIL_KIND.COMPACTION_FINISHED,
]);

// "runtime_starting" and "working" are dropped: nothing in the daemon ever
// emits either detail kind. The daemon has exactly one spawn moment, already
// reported as "starting"; "checking_messages" stays for a sibling branch.
const workingKinds = new Set([
  "model_request_started",
  "message_received",
  "model_response_started",
  "running_command",
  "tool_started",
  "freshness_hold",
  "runtime_progress",
  "runtime_reconnecting",
  "starting",
  "checking_messages",
  "compacting_context",
  // ADR 0021 liveness-only fillers: still "working" while visible.
  "tool_end",
  "thinking_end",
  "compaction_finished",
  // ADR 0021 visible, stored busy detail kinds.
  "subagent_activity",
]);

export function activityKindForObservation(
  observation: Pick<AgentActivity, "detailKind" | "level">,
): Exclude<AgentActivityKind, "offline"> | undefined {
  if (
    observation.level === "error" ||
    observation.detailKind === "runtime_error" ||
    observation.detailKind === "runtime_crashed"
  )
    return "error";
  if (observation.detailKind === "thinking_started") return "thinking";
  if (observation.detailKind === "idle" || observation.detailKind === "runtime_interrupted")
    return "online";
  if (workingKinds.has(observation.detailKind)) return "working";
  return undefined;
}

const LUA_COMMON = `
local function decode_state(raw)
  if not raw then return {} end
  local ok, state = pcall(cjson.decode, raw)
  if not ok or type(state) ~= "table" then return {} end
  return state
end

local function revision(state)
  local redis_time = redis.call("TIME")
  local server_time_floor = tonumber(redis_time[1]) * 1000000 + tonumber(redis_time[2])
  local stored_revision = tonumber(redis.call("GET", KEYS[2])) or 0
  local state_revision = tonumber(state.revision) or 0
  local next_revision = math.max(server_time_floor, stored_revision + 1, state_revision + 1)
  local encoded_revision = string.format("%.0f", next_revision)
  -- The counter deliberately outlives the 24-hour display state. Redis TIME is
  -- the fallback lower bound when eviction or a datastore reset removes both.
  -- Keep the revision as a string inside Redis because cjson encodes Lua numbers
  -- with only 14 significant digits, below the precision of this microsecond value.
  redis.call("SET", KEYS[2], encoded_revision)
  state.revision = encoded_revision
  return next_revision
end

local function save(state)
  redis.call("SET", KEYS[1], cjson.encode(state), "EX", 86400)
end

local function project(state, now)
  local changed = false
  if state.process and state.process.status == "active" and not state.processExpired and
      now >= state.process.leaseUntil then
    state.processExpired = true
    state.activityVisible = false
    changed = true
  elseif state.process and state.process.status == "active" and not state.processExpired and
      state.activityVisible and state.activity and
      (state.activity.kind == "working" or state.activity.kind == "thinking") and
      now >= state.activity.expiresAt then
    state.activityVisible = false
    changed = true
  end
  if changed then revision(state) end
  return changed
end

local function snapshot(state, workspace_id, computer_id, agent_id, now)
  local active = state.process and state.process.status == "active" and not state.processExpired and
    now < state.process.leaseUntil
  local kind = "offline"
  local detail_kind = ""
  local detail = ""
  local entries = {}
  local expires_at = cjson.null
  if active then
    kind = "online"
    expires_at = state.process.leaseUntil
    if state.activityVisible and state.activity then
      kind = state.activity.kind
      detail_kind = state.activity.detailKind
      detail = state.activity.detail
      entries = state.activity.entries or {}
      if kind == "working" or kind == "thinking" then
        if state.activity.expiresAt < expires_at then expires_at = state.activity.expiresAt end
      end
    end
  end
  return cjson.encode({
    protocolMajor = 1, workspaceId = workspace_id, computerId = computer_id,
    agentId = agent_id, revision = state.revision, activityKind = kind,
    detailKind = detail_kind, detail = detail, entries = entries, expiresAt = expires_at
  })
end
`;

const OBSERVE_STATUS = `${LUA_COMMON}
local state = decode_state(redis.call("GET", KEYS[1]))
local now = tonumber(ARGV[1])
local projected = project(state, now)
local function reject()
  if projected then save(state) end
  return false
end
local current = state.process
local same_instance = current and current.daemonInstanceId == ARGV[6]
local accepted = not current
if current then
  if same_instance then
    accepted = tonumber(ARGV[7]) > tonumber(current.sequence) or
      (tonumber(ARGV[7]) == tonumber(current.sequence) and current.status == ARGV[5] and
        tonumber(ARGV[8]) == tonumber(current.observedAt))
  else
    accepted = tonumber(ARGV[8]) > tonumber(current.observedAt)
  end
end
if not accepted then return reject() end

local preserve_provisional = not current and state.activityVisible and state.activity and
  state.activity.daemonInstanceId == ARGV[6]
local reset_activity = (current and (not same_instance or current.status == "inactive")) or ARGV[5] == "inactive"
if reset_activity or (not preserve_provisional and not current) then state.activityVisible = false end
state.process = {
  status = ARGV[5], daemonInstanceId = ARGV[6], sequence = tonumber(ARGV[7]),
  observedAt = tonumber(ARGV[8]), leaseUntil = ARGV[5] == "active" and
    now + tonumber(ARGV[9]) or cjson.null
}
state.processExpired = false
-- Any accepted observation is real evidence from the daemon, so it cancels a
-- pending liveness probe the same way a real Activity observation does.
state.probe = nil
if ARGV[5] == "inactive" then
  redis.call("ZREM", KEYS[3], ARGV[2] .. ":" .. ARGV[3] .. ":" .. ARGV[4])
end
revision(state)
save(state)
return snapshot(state, ARGV[2], ARGV[3], ARGV[4], now)
`;

const OBSERVE_ACTIVITY = `${LUA_COMMON}
local state = decode_state(redis.call("GET", KEYS[1]))
local now = tonumber(ARGV[1])
local projected = project(state, now)
local function reject()
  if projected then save(state) end
  return false
end
if ARGV[7] ~= ARGV[9] then return reject() end
if state.process then
  if state.process.daemonInstanceId ~= ARGV[8] or state.process.status ~= "active" or
      now >= state.process.leaseUntil then return reject() end
end
local previous = state.activity
local was_visible = state.activityVisible
if state.retiredLaunchId == ARGV[7] then return reject() end
if previous then
  if previous.launchId == ARGV[7] then
    if tonumber(ARGV[10]) <= tonumber(previous.sequence) then return reject() end
  else
    if tonumber(ARGV[11]) <= tonumber(previous.observedAt) then return reject() end
    -- Retain one retired launch only. Cross-launch observedAt ordering is a bounded
    -- best-effort fence, not permanent history or a database race fence.
    state.retiredLaunchId = previous.launchId
  end
end
-- A busy heartbeat or a content-free runtime_progress frame (ARGV[15] == "1")
-- only renews the lease below; it bumps the revision counter (and so the
-- realtime push) only when it actually changes what is shown.
local is_filler = ARGV[15] == "1"
local visible_changed = not was_visible or not previous or
  previous.kind ~= ARGV[5] or previous.detailKind ~= ARGV[6] or previous.detail ~= ARGV[12]
state.activity = {
  launchId = ARGV[7], daemonInstanceId = ARGV[8], sequence = tonumber(ARGV[10]),
  observedAt = tonumber(ARGV[11]), receivedAt = now, kind = ARGV[5],
  detailKind = ARGV[6], detail = ARGV[12], entries = cjson.decode(ARGV[13]),
  expiresAt = (ARGV[5] == "working" or ARGV[5] == "thinking") and
    now + tonumber(ARGV[14]) or cjson.null
}
state.activityVisible = true
-- Any accepted observation is real evidence from the daemon (a probe reply
-- included), so it cancels a pending liveness probe outright.
state.probe = nil
local lease_member = ARGV[2] .. ":" .. ARGV[3] .. ":" .. ARGV[4]
if ARGV[5] == "working" or ARGV[5] == "thinking" then
  redis.call("ZADD", KEYS[3], state.activity.expiresAt, lease_member)
else
  redis.call("ZREM", KEYS[3], lease_member)
end
if not is_filler or visible_changed then revision(state) end
save(state)
return snapshot(state, ARGV[2], ARGV[3], ARGV[4], now)
`;

const SNAPSHOT = `${LUA_COMMON}
local raw = redis.call("GET", KEYS[1])
local state = decode_state(raw)
local now = tonumber(ARGV[1])
local changed = project(state, now)
if not raw then revision(state) changed = true end
if changed then save(state) end
return snapshot(state, ARGV[2], ARGV[3], ARGV[4], now)
`;

// ARGV: [1] now, [2] workspaceId, [3] computerId, [4] agentId, [5] probeId, [6] probeTimeoutMs
//
// Deliberately does not call the shared project() helper: project() itself
// flips activityVisible off once a busy lease naturally lapses, which would
// destroy the very "stale but not yet probed" signal this script needs to
// see before that lazy projection is allowed to happen.
const SWEEP_STALE = `${LUA_COMMON}
local state = decode_state(redis.call("GET", KEYS[1]))
local now = tonumber(ARGV[1])
local probe_id = ARGV[5]
local timeout_ms = tonumber(ARGV[6])
local member = ARGV[2] .. ":" .. ARGV[3] .. ":" .. ARGV[4]
local process_alive = state.process and state.process.status == "active" and
  not state.processExpired and now < state.process.leaseUntil
local busy_visible = process_alive and state.activityVisible and state.activity and
  (state.activity.kind == "working" or state.activity.kind == "thinking")
if not busy_visible then
  redis.call("ZREM", KEYS[3], member)
  return cjson.encode({ outcome = "fresh" })
end
if tonumber(state.activity.expiresAt) > now then
  -- The lease was renewed (a heartbeat or a real observation landed) between
  -- the ZRANGEBYSCORE read that found this member and this call. Re-index at
  -- its new score instead of dropping it, or a lease renewed in that narrow
  -- window would silently fall out of the sweep until it goes stale again.
  redis.call("ZADD", KEYS[3], state.activity.expiresAt, member)
  return cjson.encode({ outcome = "fresh" })
end
if state.probe then
  if now - tonumber(state.probe.sentAt) < timeout_ms then
    return cjson.encode({ outcome = "waiting" })
  end
  state.activityVisible = false
  state.probe = nil
  revision(state)
  save(state)
  redis.call("ZREM", KEYS[3], member)
  return cjson.encode({
    outcome = "expired",
    snapshot = cjson.decode(snapshot(state, ARGV[2], ARGV[3], ARGV[4], now))
  })
end
state.probe = { id = probe_id, sentAt = now }
save(state)
return cjson.encode({ outcome = "probe" })
`;

export type Scope = Pick<AgentStatus, "workspaceId" | "computerId" | "agentId">;
type RedisPort = {
  eval(
    script: string,
    numberOfKeys: number,
    ...keysAndArgs: Array<string | number>
  ): Promise<unknown>;
  get(key: string): Promise<string | null>;
  zrangebyscore(
    key: string,
    min: string | number,
    max: string | number,
    ...args: Array<string | number>
  ): Promise<string[]>;
};

/** One `SWEEP_STALE` outcome. `expired` is the only one carrying a fresh snapshot to push. */
export type ActivitySweepResult =
  | { outcome: "fresh" | "waiting" | "probe" }
  | { outcome: "expired"; snapshot: AgentDisplaySnapshot };

export interface AgentDisplay {
  observeStatus(status: AgentStatus): Promise<AgentDisplaySnapshot | undefined>;
  observeActivity(
    activity: AgentActivity & { computerId: string },
    fence: { daemonInstanceId: string; launchId: string },
  ): Promise<AgentDisplaySnapshot | undefined>;
  snapshot(scope: Scope): Promise<AgentDisplaySnapshot>;
  /** Up to `limit` scopes whose busy lease score is at or before `now`, oldest first. */
  staleLeases(now: number, limit: number): Promise<Scope[]>;
  /** Advances one Agent's pending liveness probe; see ADR 0020 for the outcome semantics. */
  sweepStale(
    scope: Scope,
    args: { probeId: string; timeoutMs: number },
  ): Promise<ActivitySweepResult>;
}

export class RedisAgentDisplay implements AgentDisplay {
  constructor(
    private readonly redis: RedisPort,
    private readonly clock: () => number = Date.now,
  ) {}

  async observeStatus(status: AgentStatus) {
    return this.execute(OBSERVE_STATUS, status, [
      status.status,
      status.daemonInstanceId,
      status.clientSeq,
      status.observedAtMs,
      AGENT_STATUS_LEASE_MS,
    ]);
  }

  async observeActivity(
    activity: AgentActivity & { computerId: string },
    fence: { daemonInstanceId: string; launchId: string },
  ) {
    const kind = activityKindForObservation(activity);
    if (!kind) return undefined;
    const isFiller =
      activity.isHeartbeat === true || LIVENESS_ONLY_DETAIL_KINDS.has(activity.detailKind);
    return this.execute(OBSERVE_ACTIVITY, activity, [
      kind,
      activity.detailKind,
      activity.launchId,
      fence.daemonInstanceId,
      fence.launchId,
      activity.clientSeq,
      activity.observedAtMs,
      activity.detail,
      JSON.stringify(activity.entries ?? []),
      WORKING_LEASE_MS,
      isFiller ? "1" : "0",
    ]);
  }

  async snapshot(scope: Scope) {
    const result = await this.execute(SNAPSHOT, scope, []);
    if (!result) throw new Error("Agent display snapshot transaction returned no result");
    return result;
  }

  async staleLeases(now: number, limit: number): Promise<Scope[]> {
    const members = await this.redis.zrangebyscore(LEASES_KEY, "-inf", now, "LIMIT", 0, limit);
    return members.flatMap((member) => {
      const [workspaceId, computerId, agentId] = member.split(":");
      return workspaceId && computerId && agentId ? [{ workspaceId, computerId, agentId }] : [];
    });
  }

  async sweepStale(
    scope: Scope,
    args: { probeId: string; timeoutMs: number },
  ): Promise<ActivitySweepResult> {
    const result = await this.redis.eval(
      SWEEP_STALE,
      3,
      this.stateKey(scope),
      this.revisionKey(scope),
      LEASES_KEY,
      this.clock(),
      scope.workspaceId,
      scope.computerId,
      scope.agentId,
      args.probeId,
      args.timeoutMs,
    );
    if (typeof result !== "string")
      throw new Error("Agent activity sweep transaction returned no result");
    const parsed = JSON.parse(result) as {
      outcome: ActivitySweepResult["outcome"];
      snapshot?: Record<string, unknown>;
    };
    if (parsed.outcome !== "expired") return { outcome: parsed.outcome };
    if (!parsed.snapshot) throw new Error("expired Agent activity sweep is missing its snapshot");
    const snapshot = parsed.snapshot;
    snapshot.revision = Number(snapshot.revision);
    snapshot.entries = Array.isArray(snapshot.entries) ? snapshot.entries : [];
    return { outcome: "expired", snapshot: parseAgentDisplaySnapshot(snapshot) };
  }

  private async execute(script: string, scope: Scope, args: Array<string | number>) {
    const result = await this.redis.eval(
      script,
      3,
      this.stateKey(scope),
      this.revisionKey(scope),
      LEASES_KEY,
      this.clock(),
      scope.workspaceId,
      scope.computerId,
      scope.agentId,
      ...args,
    );
    if (typeof result !== "string") return undefined;
    const snapshot = JSON.parse(result) as Record<string, unknown>;
    snapshot.revision = Number(snapshot.revision);
    snapshot.entries = Array.isArray(snapshot.entries) ? snapshot.entries : [];
    return parseAgentDisplaySnapshot(snapshot);
  }

  private stateKey(scope: Scope) {
    return `${this.keyPrefix(scope)}:state`;
  }

  private revisionKey(scope: Scope) {
    return `${this.keyPrefix(scope)}:revision`;
  }

  private keyPrefix(scope: Scope) {
    const segment = (value: string) => encodeURIComponent(value);
    return `coforge:workspace:${segment(scope.workspaceId)}:computer:${segment(scope.computerId)}:agent:${segment(scope.agentId)}:display:v1`;
  }
}

let singleton: RedisAgentDisplay | undefined;

export function getAgentDisplay(): AgentDisplay {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error("REDIS_URL is required for Agent display");
  singleton ??= new RedisAgentDisplay(new RedisClient(redisUrl));
  return singleton;
}
