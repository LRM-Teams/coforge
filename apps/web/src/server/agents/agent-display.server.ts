import { RedisClient } from "bun";
import type { AgentActivity, AgentStatus } from "@coforge/protocol";
import {
  parseAgentDisplaySnapshot,
  type AgentActivityKind,
  type AgentDisplaySnapshot,
} from "@coforge/protocol/agent-display";
import { AGENT_STATUS_LEASE_MS } from "./agent-status.server";

const WORKING_LEASE_MS = 60_000;

const workingKinds = new Set([
  "model_request_started",
  "message_received",
  "model_response_started",
  "running_command",
  "tool_started",
  "working",
  "freshness_hold",
  "runtime_progress",
  "runtime_starting",
  "starting",
  "checking_messages",
  "compacting_context",
]);

export function activityKindForObservation(
  observation: Pick<AgentActivity, "detailKind" | "level">,
): Exclude<AgentActivityKind, "offline"> | undefined {
  if (observation.level === "error" || observation.detailKind === "runtime_error") return "error";
  if (observation.detailKind === "thinking_started") return "thinking";
  if (observation.detailKind === "idle" || observation.detailKind === "turn_completed")
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
state.activity = {
  launchId = ARGV[7], daemonInstanceId = ARGV[8], sequence = tonumber(ARGV[10]),
  observedAt = tonumber(ARGV[11]), receivedAt = now, kind = ARGV[5],
  detailKind = ARGV[6], detail = ARGV[12], entries = cjson.decode(ARGV[13]),
  expiresAt = (ARGV[5] == "working" or ARGV[5] == "thinking") and
    now + tonumber(ARGV[14]) or cjson.null
}
state.activityVisible = true
revision(state)
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

type Scope = Pick<AgentStatus, "workspaceId" | "computerId" | "agentId">;
type RedisPort = {
  eval(
    script: string,
    numberOfKeys: number,
    ...keysAndArgs: Array<string | number>
  ): Promise<unknown>;
  get(key: string): Promise<string | null>;
};

export interface AgentDisplay {
  observeStatus(status: AgentStatus): Promise<AgentDisplaySnapshot | undefined>;
  observeActivity(
    activity: AgentActivity & { computerId: string },
    fence: { daemonInstanceId: string; launchId: string },
  ): Promise<AgentDisplaySnapshot | undefined>;
  snapshot(scope: Scope): Promise<AgentDisplaySnapshot>;
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
    ]);
  }

  async snapshot(scope: Scope) {
    const result = await this.execute(SNAPSHOT, scope, []);
    if (!result) throw new Error("Agent display snapshot transaction returned no result");
    return result;
  }

  private async execute(script: string, scope: Scope, args: Array<string | number>) {
    const result = await this.redis.eval(
      script,
      2,
      this.stateKey(scope),
      this.revisionKey(scope),
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
    return `coforge:agent-display:v1:${segment(scope.workspaceId)}:${segment(scope.computerId)}:${segment(scope.agentId)}`;
  }
}

let singleton: RedisAgentDisplay | undefined;

export function getAgentDisplay(): AgentDisplay {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error("REDIS_URL is required for Agent display");
  singleton ??= new RedisAgentDisplay(new RedisClient(redisUrl));
  return singleton;
}
