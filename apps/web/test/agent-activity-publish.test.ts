import { describe, expect, test } from "bun:test";
import { decodeAgentActivity, encodeAgentActivity } from "@coforge/protocol";

import { handleAgentActivityPublication } from "../src/server/agents/agent-activity-publish.server";

const activity = {
  protocolMajor: 1,
  requestId: "activity-1",
  workspaceId: "workspace-1",
  agentId: "agent-1",
  detailKind: "tool_started",
  level: "info",
  detail: "Running a tool",
  observedAtMs: Date.parse("2026-08-29T00:00:00.000Z"),
  launchId: "launch-1",
  clientSeq: 1,
} as const;

function encodedActivity() {
  let binary = "";
  for (const byte of encodeAgentActivity(activity)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const request = (overrides: Record<string, unknown> = {}, secret = "test-secret") =>
  new Request("http://backend/api/internal/centrifugo-agent-activity", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-coforge-centrifugo-proxy-secret": secret,
    },
    body: JSON.stringify({
      user: "user-1",
      channel: "activity:workspace-1",
      b64data: encodedActivity(),
      meta: { workspace_id: "workspace-1", computer_id: "computer-1" },
      ...overrides,
    }),
  });

describe("Agent activity publication", () => {
  test("passes the authenticated Computer scope to persistence", async () => {
    const received: unknown[] = [];
    const response = await handleAgentActivityPublication(request(), {
      proxySecret: "test-secret",
      agentBelongsToWorkspace: async () => true,
      agentBelongsToComputer: async () => true,
      computerBelongsToWorkspace: async () => true,
      observe: async (value) => {
        received.push(value);
      },
    });

    const result = (await response.json()) as {
      result: { skip_history: boolean; b64data: string };
    };
    expect(result.result.skip_history).toBe(true);
    expect(
      decodeAgentActivity(
        Uint8Array.from(atob(result.result.b64data), (character) => character.charCodeAt(0)),
      ).activityKind,
    ).toBe("working");
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      ...activity,
      activityKind: "working",
      computerId: "computer-1",
    });
  });

  test("overrides forged display kinds and isolates display failures from history", async () => {
    const forged = encodeAgentActivity({ ...activity, activityKind: "error" });
    let binary = "";
    for (const byte of forged) binary += String.fromCharCode(byte);
    const history: unknown[] = [];
    const response = await handleAgentActivityPublication(request({ b64data: btoa(binary) }), {
      proxySecret: "test-secret",
      agentBelongsToWorkspace: async () => true,
      agentBelongsToComputer: async () => true,
      computerBelongsToWorkspace: async () => true,
      observe: async (value) => {
        history.push(value);
      },
      currentRuntimeFence: async () => ({ daemonInstanceId: "daemon-1", launchId: "launch-1" }),
      display: {
        observeActivity: async () => {
          throw new Error("Redis unavailable");
        },
      },
    });
    const result = (await response.json()) as { result: { b64data: string } };
    const published = decodeAgentActivity(
      Uint8Array.from(atob(result.result.b64data), (character) => character.charCodeAt(0)),
    );
    expect(published.activityKind).toBe("working");
    expect(history).toHaveLength(1);
  });

  test("does not reduce an authorized observation without a current launch fence", async () => {
    let reduced = false;
    await handleAgentActivityPublication(request(), {
      proxySecret: "test-secret",
      agentBelongsToWorkspace: async () => true,
      agentBelongsToComputer: async () => true,
      computerBelongsToWorkspace: async () => true,
      observe: async () => {
        throw new Error("history unavailable");
      },
      currentRuntimeFence: async () => undefined,
      display: {
        observeActivity: async () => {
          reduced = true;
          return undefined;
        },
      },
    });
    expect(reduced).toBe(false);
  });

  test("rejects an untrusted proxy or mismatched connection scope", async () => {
    const dependencies = {
      proxySecret: "test-secret",
      agentBelongsToWorkspace: async () => true,
      agentBelongsToComputer: async () => true,
      computerBelongsToWorkspace: async () => true,
      observe: async () => {},
    };

    expect(
      await (await handleAgentActivityPublication(request({}, "wrong"), dependencies)).json(),
    ).toEqual({
      error: { code: 403, message: "activity publication is not authorized" },
    });
    expect(
      await (
        await handleAgentActivityPublication(
          request({
            meta: { workspace_id: "other", computer_id: "computer-1" },
          }),
          dependencies,
        )
      ).json(),
    ).toEqual({
      error: { code: 403, message: "activity publication is not authorized" },
    });
  });

  test("rejects an Agent or Computer outside the authenticated Workspace", async () => {
    for (const dependencies of [
      {
        proxySecret: "test-secret",
        agentBelongsToWorkspace: async () => false,
        agentBelongsToComputer: async () => true,
        computerBelongsToWorkspace: async () => true,
        observe: async () => {},
      },
      {
        proxySecret: "test-secret",
        agentBelongsToWorkspace: async () => true,
        computerBelongsToWorkspace: async () => false,
        agentBelongsToComputer: async () => true,
        observe: async () => {},
      },
    ])
      expect(await (await handleAgentActivityPublication(request(), dependencies)).json()).toEqual({
        error: { code: 403, message: "activity publication is not authorized" },
      });
  });

  test("rejects an Agent bound to another authenticated Computer", async () => {
    const response = await handleAgentActivityPublication(request(), {
      proxySecret: "test-secret",
      agentBelongsToWorkspace: async () => true,
      computerBelongsToWorkspace: async () => true,
      agentBelongsToComputer: async () => false,
      observe: async () => {},
    });
    expect(response.status).toBe(200);
    expect((await response.json()).error).toEqual({
      code: 403,
      message: "activity publication is not authorized",
    });
  });
});
