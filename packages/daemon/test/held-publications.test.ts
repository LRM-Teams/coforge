import { expect, test } from "bun:test";
import { HeldPublications } from "#src/connection/held-publications";

test("a keyed item replaces the earlier one under its key and takes the newer arrival's place", () => {
  const held = new HeldPublications<string>();
  held.latestFor("agent-1", "start", "start-1");
  held.latestFor("agent-1", "stop", "stop-1");
  held.add("purge-1");
  held.latestFor("agent-1", "start", "start-2");

  expect(held.take()).toEqual({ items: ["stop-1", "purge-1", "start-2"], dropped: 0 });
});

test("past the cap, each Agent keeps only its latest notice and the rest are dropped and counted", () => {
  const held = new HeldPublications<string>(2);

  for (const notice of ["a1", "a2", "a3", "a4"]) held.notice("agent-a", notice);
  held.notice("agent-b", "b1");

  expect(held.take()).toEqual({ items: ["a1", "a2", "a4", "b1"], dropped: 1 });
});

test("take empties the buffer and starts a fresh count", () => {
  const held = new HeldPublications<string>(1);
  held.notice("agent-a", "a");
  held.notice("agent-a", "b");
  held.notice("agent-a", "x");
  held.take();

  held.notice("agent-a", "c");
  expect(held.take()).toEqual({ items: ["c"], dropped: 0 });
});
