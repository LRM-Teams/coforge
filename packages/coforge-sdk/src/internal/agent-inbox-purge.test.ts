import { create, toBinary } from "@bufbuild/protobuf";
import { expect, test } from "bun:test";
import { AgentInboxPurgeSchema } from "#src/internal/gen/coforge/rpc/v1/workspace_pb";
import {
  AGENT_INBOX_PURGE_MESSAGE_TYPE,
  decodeAgentInboxPurge,
  encodeAgentInboxPurge,
} from "./index";

const purge = {
  protocolMajor: 1,
  requestId: "request-1",
  workspaceId: "workspace-1",
  computerId: "computer-1",
  agentId: "agent-1",
  conversationIds: ["conversation-team", "conversation-ops"],
  targets: ["#team", "#ops"],
  reason: "member_removed" as const,
};

test("round-trips an inbox purge for the channels an Agent can no longer read", () => {
  expect(decodeAgentInboxPurge(encodeAgentInboxPurge(purge))).toEqual(purge);
});

test("rejects inbox purges with a missing field, a non-channel target, or an unknown reason", () => {
  const encoded = (overrides: Record<string, unknown>) =>
    toBinary(
      AgentInboxPurgeSchema,
      create(AgentInboxPurgeSchema, {
        ...purge,
        messageType: AGENT_INBOX_PURGE_MESSAGE_TYPE,
        ...overrides,
      }),
    );

  for (const overrides of [
    { workspaceId: "" },
    { computerId: "" },
    { agentId: "" },
    { conversationIds: [] },
    { conversationIds: ["conversation-team", ""] },
    { targets: ["@ada"] },
    { targets: ["#"] },
    { reason: "because" },
    { messageType: "coforge.rpc.v1.AgentActivityProbe" },
  ])
    expect(() => decodeAgentInboxPurge(encoded(overrides))).toThrow("invalid agent inbox purge");
});
