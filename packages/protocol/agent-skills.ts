import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  AgentSkillsListRequestSchema,
  AgentSkillsListResultSchema,
} from "./gen/coforge/rpc/v1/agent_skills_pb";
import type { RuntimeProvider } from "./index";

export const AGENT_SKILLS_LIST_METHOD = "agent:skills:list";
export const AGENT_SKILLS_LIST_RESULT_METHOD = "agent:skills:list_result";
const REQUEST_TYPE = "coforge.rpc.v1.AgentSkillsListRequest";
const RESULT_TYPE = "coforge.rpc.v1.AgentSkillsListResult";
const MAX_BYTES = 1_048_576;

export type AgentSkillsListRequest = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
  provider: RuntimeProvider;
};
export type AgentSkillsScope = {
  status: "ok" | "partial" | "error" | "unsupported";
  entries: { name: string; description: string; sourcePath: string }[];
  directories: { path: string; status: "scanned" | "missing" | "unreadable" | "unsupported" }[];
};
export type AgentSkillsListResult = AgentSkillsListRequest & {
  scannedAtMs: number;
  global: AgentSkillsScope;
  workspace: AgentSkillsScope;
};

function request(value: {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
  provider: string;
}): AgentSkillsListRequest {
  if (
    value.protocolMajor !== 1 ||
    [value.requestId, value.workspaceId, value.computerId, value.agentId].some(
      (id) => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id),
    )
  )
    throw new Error("Invalid Skills request scope");
  const provider = value.provider;
  if (
    provider !== "coforge" &&
    provider !== "pi" &&
    provider !== "codex" &&
    provider !== "claude-code"
  )
    throw new Error("Invalid Skills provider");
  return {
    protocolMajor: 1,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    computerId: value.computerId,
    agentId: value.agentId,
    provider,
  };
}
function text(value: string, max: number, nonempty = false) {
  if (
    value.length > max ||
    (nonempty && !value.trim()) ||
    // oxlint-disable-next-line no-control-regex -- Reject control bytes in untrusted metadata.
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
  )
    throw new Error("Invalid Skills metadata");
  return value;
}
function source(value: string) {
  text(value, 512, true);
  if (/^(?:[\\/]|[A-Za-z]:)/.test(value) || value.includes("\\") || value.split("/").includes(".."))
    throw new Error("Invalid Skills source label");
  return value;
}
function scope(
  value:
    | {
        status: string;
        entries: { name: string; description: string; sourcePath: string }[];
        directories: { path: string; status: string }[];
      }
    | undefined,
): AgentSkillsScope {
  if (
    !value ||
    !["ok", "partial", "error", "unsupported"].includes(value.status) ||
    value.entries.length > 256 ||
    value.directories.length > 16
  )
    throw new Error("Invalid Skills scope");
  return {
    status: value.status as AgentSkillsScope["status"],
    entries: value.entries.map((entry) => ({
      name: text(entry.name, 128, true),
      description: text(entry.description, 512),
      sourcePath: source(entry.sourcePath),
    })),
    directories: value.directories.map((directory) => {
      if (!["scanned", "missing", "unreadable", "unsupported"].includes(directory.status))
        throw new Error("Invalid Skills directory");
      return {
        path: source(directory.path),
        status: directory.status as AgentSkillsScope["directories"][number]["status"],
      };
    }),
  };
}
function bounded(bytes: Uint8Array) {
  if (bytes.length > MAX_BYTES) throw new Error("Skills payload too large");
  return bytes;
}
export function encodeAgentSkillsListRequest(value: AgentSkillsListRequest): Uint8Array {
  return toBinary(
    AgentSkillsListRequestSchema,
    create(AgentSkillsListRequestSchema, { ...request(value), messageType: REQUEST_TYPE }),
  );
}
export function decodeAgentSkillsListRequest(bytes: Uint8Array): AgentSkillsListRequest {
  const value = fromBinary(AgentSkillsListRequestSchema, bounded(bytes));
  if (value.messageType !== REQUEST_TYPE) throw new Error("Invalid Skills request type");
  return request(value);
}
export function encodeAgentSkillsListResult(value: AgentSkillsListResult): Uint8Array {
  if (!Number.isSafeInteger(value.scannedAtMs) || value.scannedAtMs < 0)
    throw new Error("Invalid Skills timestamp");
  return bounded(
    toBinary(
      AgentSkillsListResultSchema,
      create(AgentSkillsListResultSchema, {
        ...request(value),
        messageType: RESULT_TYPE,
        scannedAtMs: BigInt(value.scannedAtMs),
        global: scope(value.global),
        workspace: scope(value.workspace),
      }),
    ),
  );
}
export function decodeAgentSkillsListResult(bytes: Uint8Array): AgentSkillsListResult {
  const value = fromBinary(AgentSkillsListResultSchema, bounded(bytes));
  if (value.messageType !== RESULT_TYPE || value.scannedAtMs > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Invalid Skills result");
  return {
    ...request(value),
    scannedAtMs: Number(value.scannedAtMs),
    global: scope(value.global),
    workspace: scope(value.workspace),
  };
}
