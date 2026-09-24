import { expect, test } from "bun:test";

import {
  NO_OWNER,
  NO_PROJECT,
  filterParam,
  ownerOptions,
  parseFilterParam,
  projectOptions,
  taskMatches,
  type FilterableTask,
} from "#src/features/tasks/task-filters";

/**
 * The Tasks page filters by owner and by Project: several of each may be picked, a Task matches
 * when its owner is one of the picked owners and its Project one of the picked Projects, and an
 * empty pick means everyone / every Project.
 */
const VIEWER = "user-viewer";
const person = (id: string, name: string) => ({
  memberId: `m-${id}`,
  kind: "user" as const,
  id,
  name,
  handle: name.toLowerCase(),
});
const agent = (id: string, name: string) => ({
  memberId: `m-${id}`,
  kind: "agent" as const,
  id,
  name,
  handle: name.toLowerCase(),
});
const launch = { id: "p-launch", name: "Launch", slug: "launch" };
const infra = { id: "p-infra", name: "Infra", slug: "infra" };
// The viewer's membership differs per conversation; each Task carries the one of its own.
const task = (owner: FilterableTask["owner"], project: FilterableTask["project"]) => ({
  owner,
  project,
  currentMemberId: `m-${VIEWER}`,
});
const tasks: FilterableTask[] = [
  task(person(VIEWER, "Dev User"), launch),
  task(person("user-jordan", "Jordan Lee"), launch),
  task(agent("agent-nova", "Nova"), infra),
  task(null, null),
  task(agent("agent-atlas", "Atlas"), null),
];

test("an empty pick keeps every Task", () => {
  expect(tasks.filter((task) => taskMatches(task, { owners: [], projects: [] }))).toEqual(tasks);
});

test("owners and Projects each match any picked value, and the two narrow together", () => {
  const picked = { owners: [VIEWER, "user-jordan", NO_OWNER], projects: [launch.id] };
  expect(tasks.filter((task) => taskMatches(task, picked))).toEqual([tasks[0], tasks[1]]);
  const noProject = { owners: [], projects: [NO_PROJECT] };
  expect(tasks.filter((task) => taskMatches(task, noProject))).toEqual([tasks[3], tasks[4]]);
});

test("owner choices: the viewer and Unassigned first, then people, then Agents, with counts", () => {
  expect(ownerOptions(tasks)).toEqual([
    { id: VIEWER, kind: "me", name: "Dev User", count: 1 },
    { id: NO_OWNER, kind: "none", name: "", count: 1 },
    { id: "user-jordan", kind: "user", name: "Jordan Lee", count: 1 },
    { id: "agent-atlas", kind: "agent", name: "Atlas", count: 1 },
    { id: "agent-nova", kind: "agent", name: "Nova", count: 1 },
  ]);
});

test("Project choices by name, then No project, with counts", () => {
  expect(projectOptions(tasks)).toEqual([
    { id: infra.id, name: "Infra", count: 1 },
    { id: launch.id, name: "Launch", count: 2 },
    { id: NO_PROJECT, name: "", count: 2 },
  ]);
});

test("the picks travel in the address as one comma-separated value each", () => {
  expect(filterParam([VIEWER, NO_OWNER])).toBe(`${VIEWER},none`);
  expect(filterParam([])).toBeUndefined();
  expect(parseFilterParam(`${VIEWER},none,`)).toEqual([VIEWER, NO_OWNER]);
  expect(parseFilterParam(undefined)).toEqual([]);
});

test("the viewer is Me even when their first listed Task is in a conversation they are not in", () => {
  const outside = { ...task(person(VIEWER, "Dev User"), infra), currentMemberId: null };
  expect(ownerOptions([outside, tasks[0]!])[0]).toEqual({
    id: VIEWER,
    kind: "me",
    name: "Dev User",
    count: 2,
  });
});

test("a counted group of finished Tasks adds its count to its owner and Project choices", () => {
  const finished = { ...task(person("user-jordan", "Jordan Lee"), infra), count: 40 };
  expect(ownerOptions([tasks[1]!, finished])).toEqual([
    { id: "user-jordan", kind: "user", name: "Jordan Lee", count: 41 },
  ]);
  expect(projectOptions([tasks[1]!, finished])).toEqual([
    { id: infra.id, name: "Infra", count: 40 },
    { id: launch.id, name: "Launch", count: 1 },
  ]);
});
