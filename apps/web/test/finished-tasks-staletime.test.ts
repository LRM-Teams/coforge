import { afterEach, expect, mock, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

import {
  FINISHED_TASKS_STALE_MS,
  finishedSummaryQuery,
  finishedTasksKey,
} from "#src/features/tasks/use-finished-tasks";

let summaryReads = 0;
let pageReads = 0;

mock.module("#src/features/tasks/tasks.functions", () => ({
  loadFinishedTaskSummary: async () => {
    summaryReads += 1;
    return { groups: [] };
  },
  loadFinishedTasks: async () => {
    pageReads += 1;
    return { tasks: [], nextCursor: null };
  },
}));

afterEach(() => {
  summaryReads = 0;
  pageReads = 0;
});

const SCOPE = { workspaceId: "workspace-1" } as const;

test("the summary read carries the freshness contract", () => {
  // The page reads declare the same window and reconnect policy inline in
  // `useFinishedColumn`; pinning them needs that builder exported, which is a
  // larger move than this test wants to make.
  const summary = finishedSummaryQuery(SCOPE, "week");
  expect(summary.staleTime).toBe(FINISHED_TASKS_STALE_MS);
  expect(summary.refetchOnReconnect).toBe("always");
});

test("a re-read of the same finished key within the freshness window does not call the server again", async () => {
  const client = new QueryClient();
  const options = finishedSummaryQuery(SCOPE, "week");
  await client.fetchQuery(options);
  await client.fetchQuery(options);
  expect(summaryReads).toBe(1);
});

test("an invalidation reads again whatever the age, which is how a Task change reaches the board", async () => {
  const client = new QueryClient();
  const options = finishedSummaryQuery(SCOPE, "week");
  await client.fetchQuery(options);
  expect(summaryReads).toBe(1);
  await client.invalidateQueries({ queryKey: finishedTasksKey(SCOPE.workspaceId) });
  expect(client.getQueryState(options.queryKey)?.isInvalidated).toBe(true);
  await client.fetchQuery(options);
  expect(summaryReads).toBe(2);
});

test("a different window is a different key, so it always reads", async () => {
  const client = new QueryClient();
  await client.fetchQuery(finishedSummaryQuery(SCOPE, "week"));
  await client.fetchQuery(finishedSummaryQuery(SCOPE, "month"));
  expect(summaryReads).toBe(2);
});
