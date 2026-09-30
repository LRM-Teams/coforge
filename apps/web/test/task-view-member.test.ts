import { describe, expect, test } from "bun:test";

import { taskMember } from "#src/server/tasks/task-view.server";

type Member = Parameters<typeof taskMember>[1];

const person = (names: { displayName: string | null; fullName: string | null }): Member => ({
  id: "member-1",
  userId: "user-1",
  agentId: null,
  leftAt: null,
  user: { username: "frank-an-4k2", avatarObjectKey: null, ...names },
  agent: null,
});

describe("taskMember", () => {
  test("a person is named by the label teammates see, without an @", () => {
    expect(
      taskMember("workspace-1", person({ displayName: "Frankie", fullName: "Frank An" })).name,
    ).toBe("Frankie");
    expect(
      taskMember("workspace-1", person({ displayName: null, fullName: "Frank An" })).name,
    ).toBe("Frank An");
  });

  test("the handle stays on the member, for the Agent-facing view", () => {
    expect(
      taskMember("workspace-1", person({ displayName: null, fullName: "Frank An" })),
    ).toMatchObject({ kind: "user", id: "user-1", handle: "frank-an-4k2" });
  });

  test("an Agent is still its display name, with its @handle as the handle", () => {
    expect(
      taskMember("workspace-1", {
        id: "member-2",
        userId: null,
        agentId: "agent-1",
        leftAt: null,
        user: null,
        agent: { name: "atlas", displayName: "Atlas Bot", deletedAt: null },
      }),
    ).toMatchObject({ kind: "agent", name: "Atlas Bot", handle: "atlas" });
  });
});
