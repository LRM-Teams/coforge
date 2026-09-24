import { describe, expect, test } from "bun:test";
import { groupRepliesByRoot } from "#src/features/conversations/conversation-messages";

const root = (id: string, sequence: number) => ({ id, sequence });
const reply = (id: string, sequence: number, threadRootId: string) => ({
  id,
  sequence,
  threadRootId,
});

describe("groupRepliesByRoot", () => {
  test("groups replies under their root in list order and skips top-level messages", () => {
    const a1 = reply("a1", 2, "a");
    const b1 = reply("b1", 3, "b");
    const a2 = reply("a2", 4, "a");
    const grouped = groupRepliesByRoot([root("a", 1), a1, b1, a2, root("c", 5)]);
    expect([...grouped]).toEqual([
      ["a", [a1, a2]],
      ["b", [b1]],
    ]);
  });

  test("hands back the previous grouping when no reply changed", () => {
    const a1 = reply("a1", 2, "a");
    const previous = groupRepliesByRoot([root("a", 1), a1]);
    // A new top-level message: the replies are the same objects, so the grouping is too.
    expect(groupRepliesByRoot([root("a", 1), a1, root("d", 6)], previous)).toBe(previous);
  });

  test("builds a new grouping when a reply is added, removed or replaced", () => {
    const a1 = reply("a1", 2, "a");
    const previous = groupRepliesByRoot([root("a", 1), a1]);
    expect(groupRepliesByRoot([root("a", 1), a1, reply("a2", 3, "a")], previous)).not.toBe(
      previous,
    );
    expect(groupRepliesByRoot([root("a", 1)], previous)).not.toBe(previous);
    expect(groupRepliesByRoot([root("a", 1), { ...a1 }], previous)).not.toBe(previous);
  });
});
