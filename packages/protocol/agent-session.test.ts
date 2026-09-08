import { expect, test } from "bun:test";
import {
  encodeAgentSessionReport,
  decodeAgentSessionReport,
  encodeAgentStartIntent,
  decodeAgentStartIntent,
} from "./index";

test("session reports round-trip with launch identity and reject missing scope", () => {
  const report = {
    protocolMajor: 1,
    requestId: "report",
    workspaceId: "w",
    computerId: "c",
    agentId: "a",
    provider: "codex" as const,
    sessionId: "thread",
    startRequestId: "start",
    daemonInstanceId: "daemon",
    launchId: "launch",
    previousLaunchId: "previous",
    replacedSessionId: "missing-original",
  };
  expect(decodeAgentSessionReport(encodeAgentSessionReport(report))).toEqual(report);
  expect(() => encodeAgentSessionReport({ ...report, launchId: "" })).toThrow();
  const intent = { ...report, model: "model", reasoning: "reasoning" };
  expect(decodeAgentStartIntent(encodeAgentStartIntent(intent)).previousLaunchId).toBe("previous");
  for (const sessionMode of ["create", "resume"] as const)
    expect(
      decodeAgentStartIntent(encodeAgentStartIntent({ ...intent, sessionMode })).sessionMode,
    ).toBe(sessionMode);
  expect(() =>
    decodeAgentStartIntent(
      encodeAgentStartIntent({ ...intent, sessionMode: "resume", sessionId: undefined }),
    ),
  ).toThrow("requires a session ID");
});
