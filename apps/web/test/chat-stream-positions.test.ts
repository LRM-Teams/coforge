import { expect, spyOn, test } from "bun:test";

import { chatStreamPositions } from "#src/server/conversations/chat-stream-positions.server";

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
