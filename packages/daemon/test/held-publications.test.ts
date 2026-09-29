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

test("delivery notices past the cap are dropped and counted, never held", () => {
  const held = new HeldPublications<string>(2);

  for (const notice of ["a", "b", "c", "d"]) held.notice(notice);

  expect(held.take()).toEqual({ items: ["a", "b"], dropped: 2 });
});

test("take empties the buffer and starts a fresh count", () => {
  const held = new HeldPublications<string>(1);
  held.notice("a");
  held.notice("b");
  held.take();

  held.notice("c");
  expect(held.take()).toEqual({ items: ["c"], dropped: 0 });
});
