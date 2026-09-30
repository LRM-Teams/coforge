import { expect, mock, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

/**
 * The search page's directory names channels from the same Query Chat keeps them in, so a page
 * that already holds every channel's name does not read them again.
 */
let namesRead = 0;
const conversationFunctions = await import("#src/features/conversations/channels.functions");
mock.module("#src/features/conversations/channels.functions", () => ({
  ...conversationFunctions,
  listChannelNames: async () => {
    namesRead += 1;
    return {
      streamPositions: {},
      names: [{ id: "c2", name: "zeta", description: "", archived: false }],
    };
  },
}));
const workspaceFunctions = await import("#src/features/workspaces/workspaces.functions");
mock.module("#src/features/workspaces/workspaces.functions", () => ({
  ...workspaceFunctions,
  loadWorkspaceDirectory: async () => ({ people: [], agents: [] }),
}));
const computerFunctions = await import("#src/features/computers/computers.functions");
mock.module("#src/features/computers/computers.functions", () => ({
  ...computerFunctions,
  listComputerNames: async () => [],
}));
const { searchDirectoryQuery } = await import("#src/features/search/search-queries");
const { channelNamesQuery } = await import("#src/features/conversations/conversation-queries");

test("names channels from the names Chat already holds, in name order", async () => {
  namesRead = 0;
  const queryClient = new QueryClient();
  queryClient.setQueryData(channelNamesQuery("w1").queryKey, {
    streamPositions: {},
    names: [
      { id: "c1", name: "general", description: "", archived: false },
      { id: "c0", name: "alpha", description: "", archived: false },
    ],
  });
  const directory = await queryClient.fetchQuery(searchDirectoryQuery("w1"));
  expect(directory.channels.map((channel) => channel.name)).toEqual(["alpha", "general"]);
  expect(namesRead).toBe(0);
});

test("reads the names into that Query when nothing holds them yet", async () => {
  namesRead = 0;
  const queryClient = new QueryClient();
  const directory = await queryClient.fetchQuery(searchDirectoryQuery("w1"));
  expect(directory.channels.map((channel) => channel.name)).toEqual(["zeta"]);
  expect(namesRead).toBe(1);
  expect(queryClient.getQueryData(channelNamesQuery("w1").queryKey)).toBeDefined();
});
