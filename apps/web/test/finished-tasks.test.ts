import { expect, test } from "bun:test";

import { finishedCount, finishedRows } from "#src/features/tasks/finished-tasks";

const row = (messageId: string, status: string) => ({ messageId, status });

test("a finished group shows the Tasks moved into it on the page first, then its read pages, each once", () => {
  const onPage = [row("moved", "done"), row("open", "todo"), row("reopened", "todo")];
  const pages = [row("older", "done"), row("moved", "done"), row("reopened", "done")];
  expect(finishedRows("done", onPage, pages).map(({ messageId }) => messageId)).toEqual([
    "moved",
    "older",
  ]);
});

test("a finished group's count adds the counted groups matching the owner and Project picks", () => {
  const owner = (id: string) => ({
    memberId: `m-${id}`,
    kind: "user" as const,
    id,
    name: id,
    handle: id,
  });
  const launch = { id: "p-launch", name: "Launch", slug: "launch" };
  const groups = [
    {
      status: "done" as const,
      owner: owner("ada"),
      currentMemberId: null,
      project: launch,
      count: 7,
    },
    { status: "done" as const, owner: null, currentMemberId: null, project: null, count: 3 },
    {
      status: "closed" as const,
      owner: owner("ada"),
      currentMemberId: null,
      project: launch,
      count: 2,
    },
  ];
  expect(finishedCount(groups, "done", { owners: [], projects: [] })).toBe(10);
  expect(finishedCount(groups, "done", { owners: ["ada"], projects: [] })).toBe(7);
  expect(finishedCount(groups, "closed", { owners: [], projects: ["none"] })).toBe(0);
});
