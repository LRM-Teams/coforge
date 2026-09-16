import { expect, test } from "bun:test";
import {
  encodeAgentSkillsListRequest,
  decodeAgentSkillsListRequest,
  encodeAgentSkillsListResult,
  decodeAgentSkillsListResult,
} from "./agent-skills";

const request = {
  protocolMajor: 1,
  requestId: "request-1",
  workspaceId: "workspace-1",
  computerId: "computer-1",
  agentId: "agent-1",
  provider: "codex" as const,
};
test("Agent Skills keeps request scope and separate metadata groups on the wire", () => {
  expect(decodeAgentSkillsListRequest(encodeAgentSkillsListRequest(request))).toEqual(request);
  const result = {
    ...request,
    scannedAtMs: 1234,
    global: {
      status: "ok" as const,
      entries: [
        {
          name: "review",
          description: "Review changes",
          sourcePath: "~/.agents/skills/review/SKILL.md",
        },
      ],
      directories: [{ path: "~/.agents/skills", status: "scanned" as const }],
    },
    workspace: {
      status: "partial" as const,
      entries: [],
      directories: [{ path: ".agents/skills", status: "unreadable" as const }],
    },
  };
  expect(decodeAgentSkillsListResult(encodeAgentSkillsListResult(result))).toEqual(result);
  expect(() => decodeAgentSkillsListRequest(encodeAgentSkillsListResult(result))).toThrow();
  expect(() => encodeAgentSkillsListRequest({ ...request, protocolMajor: 2 })).toThrow();
  expect(() => encodeAgentSkillsListRequest({ ...request, agentId: "../other" })).toThrow();
  expect(() =>
    encodeAgentSkillsListResult({
      ...result,
      global: {
        ...result.global,
        entries: [{ name: "leak", description: "", sourcePath: "/home/private/SKILL.md" }],
      },
    }),
  ).toThrow();
});
