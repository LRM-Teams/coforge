import { describe, expect, test } from "bun:test";
import { workspaceRedisKey } from "#src/server/redis-keys.server";

describe("workspaceRedisKey", () => {
  test("builds the workspace+computer key the stores used to spell out", () => {
    expect(
      workspaceRedisKey({ workspaceId: "w", computerId: "c", name: "status", version: "v1" }),
    ).toBe("coforge:workspace:w:computer:c:status:v1");
    expect(
      workspaceRedisKey({
        workspaceId: "w",
        computerId: "c",
        name: "reminder-capability",
        version: "v1",
      }),
    ).toBe("coforge:workspace:w:computer:c:reminder-capability:v1");
  });

  test("adds the agent segment only when there is one", () => {
    expect(
      workspaceRedisKey({
        workspaceId: "w",
        computerId: "c",
        agentId: "a",
        name: "status",
        version: "v2",
      }),
    ).toBe("coforge:workspace:w:computer:c:agent:a:status:v2");
    expect(
      workspaceRedisKey({ workspaceId: "w", computerId: "c", name: "restart", version: "v1" }),
    ).toBe("coforge:workspace:w:computer:c:restart:v1");
  });

  test("percent-encodes the ids so an id can never add a segment", () => {
    expect(
      workspaceRedisKey({
        workspaceId: "w/1",
        computerId: "c:2",
        agentId: "a 3",
        name: "display",
        version: "v1",
      }),
    ).toBe("coforge:workspace:w%2F1:computer:c%3A2:agent:a%203:display:v1");
  });
});
