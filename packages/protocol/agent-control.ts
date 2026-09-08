import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  AgentWorkspaceResetRequestSchema,
  AgentControlResultSchema,
} from "./gen/coforge/rpc/v1/agent_control_pb";
import type { RuntimeProvider } from "./index";

export const AGENT_WORKSPACE_RESET_METHOD = "agent:reset-workspace" as const;
export const AGENT_CONTROL_RESULT_METHOD = "agent:control:result" as const;

const WORKSPACE_RESET_TYPE = "coforge.rpc.v1.AgentWorkspaceResetRequest";
const RESULT_TYPE = "coforge.rpc.v1.AgentControlResult";
const MAX_BYTES = 32_768;
const MAX_COUNTER = 2 ** 31 - 1;
const SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SESSION_ID = /^[A-Za-z0-9._-]{0,128}$/;
const ERROR_CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export type SessionIdentity = {
  sessionId: string;
  state: "empty" | "resumable" | "unknown";
};

export type AgentControlScope = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
  provider: RuntimeProvider;
  epoch: number;
};

export type AgentWorkspaceResetRequest = AgentControlScope;

export type AgentControlResult = AgentControlScope & {
  phase: "stopped" | "workspace-reset" | "started" | "failed";
  launchId?: string;
  sequence: number;
  identity?: SessionIdentity;
  errorCode?: string;
};

export type AgentSessionSnapshot = AgentControlScope & {
  launchId: string;
  sequence: number;
  identity: SessionIdentity;
  daemonInstanceId?: string;
};

function bounded(bytes: Uint8Array): Uint8Array {
  if (bytes.length > MAX_BYTES) throw new Error("Agent lifecycle payload too large");
  return bytes;
}

function provider(value: string): RuntimeProvider {
  if (!["coforge", "codex", "claude-code", "pi"].includes(value))
    throw new Error("Invalid Agent lifecycle provider");
  return value as RuntimeProvider;
}

function scope(value: AgentControlScope): AgentControlScope {
  if (
    value.protocolMajor !== 1 ||
    !Number.isSafeInteger(value.epoch) ||
    value.epoch < 1 ||
    value.epoch > MAX_COUNTER ||
    [value.requestId, value.workspaceId, value.computerId, value.agentId].some(
      (id) => !SCOPE_ID.test(id),
    )
  )
    throw new Error("Invalid Agent lifecycle scope");
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    computerId: value.computerId,
    agentId: value.agentId,
    provider: provider(value.provider),
    epoch: value.epoch,
  };
}

function sequence(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_COUNTER)
    throw new Error("Invalid Agent lifecycle sequence");
  return value;
}

function identity(value: { sessionId: string; state: string } | undefined): SessionIdentity {
  if (
    !value ||
    !["empty", "resumable", "unknown"].includes(value.state) ||
    !SESSION_ID.test(value.sessionId) ||
    (value.state !== "empty" && !value.sessionId)
  )
    throw new Error("Invalid Agent session identity");
  return { sessionId: value.sessionId, state: value.state as SessionIdentity["state"] };
}

function optionalIdentity(value: { sessionId: string; state: string } | undefined) {
  return value ? identity(value) : undefined;
}

export function encodeAgentWorkspaceResetRequest(value: AgentWorkspaceResetRequest): Uint8Array {
  const checked = scope(value);
  return bounded(
    toBinary(
      AgentWorkspaceResetRequestSchema,
      create(AgentWorkspaceResetRequestSchema, {
        ...checked,
        messageType: WORKSPACE_RESET_TYPE,
      }),
    ),
  );
}

export function decodeAgentWorkspaceResetRequest(bytes: Uint8Array): AgentWorkspaceResetRequest {
  const value = fromBinary(AgentWorkspaceResetRequestSchema, bounded(bytes));
  if (value.messageType !== WORKSPACE_RESET_TYPE)
    throw new Error("Invalid Agent workspace reset request");
  return scope({ ...value, provider: provider(value.provider) });
}

function checkedResult(value: AgentControlResult): AgentControlResult {
  const checkedScope = scope(value);
  if (!["stopped", "workspace-reset", "started", "failed"].includes(value.phase))
    throw new Error("Invalid Agent lifecycle phase");
  if (value.launchId !== undefined && !SCOPE_ID.test(value.launchId))
    throw new Error("Invalid Agent lifecycle launch ID");
  if (value.errorCode !== undefined && !ERROR_CODE.test(value.errorCode))
    throw new Error("Invalid Agent lifecycle error code");
  return {
    ...checkedScope,
    phase: value.phase,
    sequence: sequence(value.sequence),
    ...(value.launchId !== undefined ? { launchId: value.launchId } : {}),
    ...(value.identity !== undefined ? { identity: identity(value.identity) } : {}),
    ...(value.errorCode !== undefined ? { errorCode: value.errorCode } : {}),
  };
}

export function encodeAgentControlResult(value: AgentControlResult): Uint8Array {
  const checked = checkedResult(value);
  return bounded(
    toBinary(
      AgentControlResultSchema,
      create(AgentControlResultSchema, { ...checked, messageType: RESULT_TYPE }),
    ),
  );
}

export function decodeAgentControlResult(bytes: Uint8Array): AgentControlResult {
  const value = fromBinary(AgentControlResultSchema, bounded(bytes));
  if (value.messageType !== RESULT_TYPE) throw new Error("Invalid Agent lifecycle result type");
  return checkedResult({
    ...value,
    provider: provider(value.provider),
    phase: value.phase as AgentControlResult["phase"],
    identity: optionalIdentity(value.identity),
  });
}

export function validateAgentSessionSnapshot(value: AgentSessionSnapshot): AgentSessionSnapshot {
  const checkedScope = scope(value);
  if (!SCOPE_ID.test(value.launchId)) throw new Error("Invalid Agent lifecycle launch ID");
  if (value.daemonInstanceId !== undefined && !SCOPE_ID.test(value.daemonInstanceId))
    throw new Error("Invalid Agent lifecycle daemon instance ID");
  return {
    ...checkedScope,
    launchId: value.launchId,
    sequence: sequence(value.sequence),
    identity: identity(value.identity),
    ...(value.daemonInstanceId !== undefined ? { daemonInstanceId: value.daemonInstanceId } : {}),
  };
}
