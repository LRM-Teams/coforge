import { describe, expect, test } from "bun:test";
import {
  applyReactionToggle,
  createReactionToggler,
} from "#src/features/conversations/message-reactions";

const thumbs = { emoji: "👍", count: 2, reactors: ["@jordan", "@atlas"] };
const party = { emoji: "🎉", count: 1, reactors: ["@casey"] };

describe("applyReactionToggle", () => {
  test("adds the viewer to an existing emoji without reordering the chips", () => {
    expect(applyReactionToggle([thumbs, party], "👍", "@dev", true)).toEqual([
      { emoji: "👍", count: 3, reactors: ["@jordan", "@atlas", "@dev"] },
      party,
    ]);
  });

  test("appends a new emoji after the existing ones (first-reaction order)", () => {
    expect(applyReactionToggle([thumbs], "🚀", "@dev", true)).toEqual([
      thumbs,
      { emoji: "🚀", count: 1, reactors: ["@dev"] },
    ]);
    expect(applyReactionToggle(undefined, "🚀", "@dev", true)).toEqual([
      { emoji: "🚀", count: 1, reactors: ["@dev"] },
    ]);
  });

  test("removes the viewer, dropping a chip nobody else holds", () => {
    const mine = { emoji: "👍", count: 3, reactors: ["@jordan", "@dev", "@atlas"] };
    expect(applyReactionToggle([mine, party], "👍", "@dev", false)).toEqual([thumbs, party]);
    expect(
      applyReactionToggle([{ emoji: "🚀", count: 1, reactors: ["@dev"] }], "🚀", "@dev", false),
    ).toBeUndefined();
  });

  test("is idempotent: re-adding or re-removing leaves the summaries as they are", () => {
    const mine = { emoji: "👍", count: 3, reactors: ["@jordan", "@atlas", "@dev"] };
    expect(applyReactionToggle([mine], "👍", "@dev", true)).toEqual([mine]);
    expect(applyReactionToggle([thumbs], "👍", "@dev", false)).toEqual([thumbs]);
  });
});

type Message = { id: string; reactions?: ReturnType<typeof applyReactionToggle> };

/** A loaded conversation of one message, with the server call held open until released. */
function harness(initial: Message["reactions"]) {
  let message: Message = { id: "m1", reactions: initial };
  let resyncs = 0;
  const toggle = createReactionToggler<Message>({
    update: (messageId, update) => {
      if (messageId === message.id) message = update(message);
    },
    resync: async () => {
      resyncs++;
    },
  });
  const gate = <T>() => {
    let release!: (value: T) => void;
    let fail!: (error: Error) => void;
    const promise = new Promise<T>((resolve, reject) => {
      release = resolve;
      fail = reject;
    });
    return { promise, release, fail };
  };
  return { toggle, gate, current: () => message.reactions, resyncs: () => resyncs };
}

describe("createReactionToggler", () => {
  test("shows the change before the server answers, then settles on the server's summary", async () => {
    const h = harness([thumbs]);
    const server = h.gate<Message["reactions"]>();
    const done = h.toggle("m1", "👍", "@dev", true, () => server.promise);
    expect(h.current()).toEqual([
      { emoji: "👍", count: 3, reactors: ["@jordan", "@atlas", "@dev"] },
    ]);
    // The server also saw a concurrent 🎉 from someone else: its answer wins.
    const authoritative = [
      { emoji: "👍", count: 3, reactors: ["@jordan", "@atlas", "@dev"] },
      party,
    ];
    server.release(authoritative);
    await done;
    expect(h.current()).toEqual(authoritative);
    expect(h.resyncs()).toBe(0);
  });

  test("an older answer arriving after a newer toggle does not overwrite it", async () => {
    const h = harness([thumbs]);
    const add = h.gate<Message["reactions"]>();
    const remove = h.gate<Message["reactions"]>();
    const first = h.toggle("m1", "👍", "@dev", true, () => add.promise);
    const second = h.toggle("m1", "👍", "@dev", false, () => remove.promise);
    remove.release([thumbs]);
    await second;
    add.release([{ emoji: "👍", count: 3, reactors: ["@jordan", "@atlas", "@dev"] }]);
    await first;
    expect(h.current()).toEqual([thumbs]);
  });

  test("a failed toggle re-reads the conversation and still reports the error", async () => {
    const h = harness([thumbs]);
    const server = h.gate<Message["reactions"]>();
    const done = h.toggle("m1", "👍", "@dev", true, () => server.promise);
    server.fail(new Error("offline"));
    await expect(done).rejects.toThrow("offline");
    expect(h.resyncs()).toBe(1);
  });
});
