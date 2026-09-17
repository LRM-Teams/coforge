import { expect, test } from "bun:test";
import { encodeAgentControlResult } from "@lrm/coforge-sdk/internal";
import { createAgentControlResultMethod } from "../src/server/centrifugo/agent-control-receiver.server";
import type { AgentControl } from "../src/server/agents/agent-control.server";
import type { CentrifugoRpcMetadata } from "../src/server/centrifugo/rpc-handler.server";

function captureWarnings() {
  const warnings: unknown[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(JSON.parse(args[0] as string));
  return {
    warnings,
    restore: () => {
      console.warn = original;
    },
  };
}

const metadata: CentrifugoRpcMetadata = {
  principal: { userId: "daemon", workspaceId: "w", computerId: "c" },
};

const payload = encodeAgentControlResult({
  protocolMajor: 1,
  requestId: "request-a",
  workspaceId: "w",
  computerId: "c",
  agentId: "agent-a",
  provider: "pi",
  epoch: 3,
  phase: "stopped",
  sequence: 2,
  errorCode: "boom",
});

test("a rejected control result logs a warning with an allowlisted reason and stays a bare 403", async () => {
  const control: Pick<AgentControl, "result"> = {
    result: async () => {
      throw new Error("Stale Agent scope");
    },
  };
  const method = createAgentControlResultMethod(control);
  const capture = captureWarnings();
  let response;
  try {
    response = await method(payload, metadata);
  } finally {
    capture.restore();
  }
  expect(response).toEqual({ code: 403, message: "Agent control result is not authorized" });
  expect(capture.warnings).toEqual([
    {
      event: "agent_control:result_rejected",
      agent_id: "agent-a",
      workspace_id: "w",
      computer_id: "c",
      phase: "stopped",
      epoch: 3,
      sequence: 2,
      error_code: "boom",
      reason: "Stale Agent scope",
    },
  ]);
});

test("an unrecognized rejection reason logs 'unexpected' plus the error name, never the raw message", async () => {
  const control: Pick<AgentControl, "result"> = {
    result: async () => {
      throw new Error("some database driver detail that must never be logged verbatim");
    },
  };
  const method = createAgentControlResultMethod(control);
  const capture = captureWarnings();
  try {
    await method(payload, metadata);
  } finally {
    capture.restore();
  }
  expect(capture.warnings).toEqual([
    expect.objectContaining({
      event: "agent_control:result_rejected",
      reason: "unexpected: Error",
    }),
  ]);
  expect(JSON.stringify(capture.warnings)).not.toContain("database driver detail");
});

test("a successful result is never logged", async () => {
  const control: Pick<AgentControl, "result"> = { result: async () => {} };
  const method = createAgentControlResultMethod(control);
  const capture = captureWarnings();
  let response;
  try {
    response = await method(payload, metadata);
  } finally {
    capture.restore();
  }
  expect(response).toEqual(new Uint8Array());
  expect(capture.warnings).toEqual([]);
});

test("daemon authentication is still rejected before the result is ever decoded", async () => {
  const control: Pick<AgentControl, "result"> = {
    result: async () => {
      throw new Error("must not be reached");
    },
  };
  const method = createAgentControlResultMethod(control);
  await expect(
    method(payload, { principal: { userId: "u", workspaceId: "", computerId: "c" } }),
  ).resolves.toEqual({ code: 401, message: "daemon authentication required" });
  await expect(
    method(payload, {
      principal: { userId: "u", workspaceId: "w", computerId: "c", agentId: "agent-a" },
    }),
  ).resolves.toEqual({ code: 401, message: "daemon authentication required" });
});
