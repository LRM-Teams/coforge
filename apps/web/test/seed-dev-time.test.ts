import { describe, expect, test } from "bun:test";
import {
  assignMissingSeedSequences,
  orderSeedMessages,
  seedTimestamp,
} from "../scripts/seed-dev-time";

describe("development seed message chronology", () => {
  test("never prepares today's messages after the captured seed time", () => {
    const now = new Date("2026-09-10T08:15:30.000Z");
    expect(seedTimestamp(now, 0, 17)).toEqual(now);
    expect(seedTimestamp(now, 1, 17)).toEqual(new Date("2026-09-09T17:00:00.000Z"));
  });

  test("orders each conversation by createdAt before sequence assignment", () => {
    const messages = orderSeedMessages([
      { key: "later", conversationId: "a", createdAt: new Date("2026-09-10T08:00:00Z") },
      { key: "other", conversationId: "b", createdAt: new Date("2026-09-08T08:00:00Z") },
      { key: "earlier", conversationId: "a", createdAt: new Date("2026-09-09T08:00:00Z") },
    ]);
    expect(messages.map(({ key }) => key)).toEqual(["earlier", "later", "other"]);
  });

  test("appends missing seed rows without changing occupied or existing seed sequences", () => {
    const messages = orderSeedMessages([
      { id: "seed-later", key: "later", conversationId: "a", createdAt: new Date("2026-09-09") },
      {
        id: "seed-existing",
        key: "existing",
        conversationId: "a",
        createdAt: new Date("2026-09-07"),
      },
      {
        id: "seed-earlier",
        key: "earlier",
        conversationId: "a",
        createdAt: new Date("2026-09-08"),
      },
    ]);

    expect(
      assignMissingSeedSequences(messages, [
        { id: "seed-existing", conversationId: "a", sequence: 1 },
        { id: "user-message", conversationId: "a", sequence: 2 },
      ]),
    ).toEqual([
      { id: "seed-earlier", sequence: 3 },
      { id: "seed-later", sequence: 4 },
    ]);
  });
});
