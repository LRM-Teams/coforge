import { expect, test } from "bun:test";

import { streamState } from "#src/features/conversations/stream-state";

test("a stream with content shows content, whatever the read is doing", () => {
  expect(streamState(3, "loading")).toBe("messages");
  expect(streamState(3, "settled")).toBe("messages");
});

test("only a settled read may call a stream empty", () => {
  // #112/#113: an empty state that lights up before the read finishes flips in front of the reader.
  expect(streamState(0, "loading")).toBe("loading");
  expect(streamState(0, "settled")).toBe("empty");
});
