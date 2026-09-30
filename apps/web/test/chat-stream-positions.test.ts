import { expect, spyOn, test } from "bun:test";

import {
  chatStreamPositions,
  readAfterStreamPositions,
} from "#src/server/conversations/chat-stream-positions.server";

const channels = ["chat:workspace:w1", "chat:user:u1"];

test("returns the positions Centrifugo reports", async () => {
  const positions = { "chat:workspace:w1": { offset: 3, epoch: "e" } };
  expect(await chatStreamPositions(channels, { streamPositions: async () => positions })).toEqual(
    positions,
  );
});

test("without Centrifugo, or when it fails, a read goes on with no positions", async () => {
  expect(await chatStreamPositions(channels, null)).toEqual({});
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(
      await chatStreamPositions(channels, {
        streamPositions: () => Promise.reject(new Error("TimeoutError")),
      }),
    ).toEqual({});
    expect(warn).toHaveBeenCalledWith(
      JSON.stringify({ event: "chat_stream_positions.unavailable" }),
    );
  } finally {
    warn.mockRestore();
  }
});

test("a list is read only once the positions are, and comes back with them", async () => {
  const positions = { "chat:user:u1": { offset: 4, epoch: "e" } };
  const events: string[] = [];
  let answer: (value: typeof positions) => void = () => {};
  const streams = {
    streamPositions: () => {
      events.push("positions requested");
      return new Promise<typeof positions>((resolve) => (answer = resolve));
    },
  };
  const done = readAfterStreamPositions(
    ["chat:user:u1"],
    async () => {
      events.push("list read");
      return ["row"];
    },
    streams,
  );
  // The positions are pending: a list read started now could hold rows written after them.
  expect(events).toEqual(["positions requested"]);
  answer(positions);
  expect(await done).toEqual({ streamPositions: positions, data: ["row"] });
  expect(events).toEqual(["positions requested", "list read"]);
});

test("a list is still read, with no positions, when they are unavailable", async () => {
  expect(await readAfterStreamPositions(channels, async () => "rows", null)).toEqual({
    streamPositions: {},
    data: "rows",
  });
});

test("a failed list read is the read's failure", async () => {
  await expect(
    readAfterStreamPositions(channels, () => Promise.reject(new Error("database down")), {
      streamPositions: async () => ({}),
    }),
  ).rejects.toThrow("database down");
});
