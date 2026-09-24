import { describe, expect, test } from "bun:test";

import {
  overviewTaskParam,
  overviewTaskParamSchema,
  parseOverviewTaskParam,
} from "#src/features/tasks/task-overview-search";

const conversationId = "0b7c6f1e-2d4a-4c8e-9f3b-5a6d7e8f9a0b";

describe("overviewTaskParamSchema", () => {
  test("keeps a conversation and Task number from the URL", () => {
    expect(overviewTaskParamSchema.parse(`${conversationId}:3`)).toBe(`${conversationId}:3`);
    expect(overviewTaskParamSchema.parse(`${conversationId}:120`)).toBe(`${conversationId}:120`);
  });

  test("treats a missing or malformed value as no open Task", () => {
    for (const value of [
      undefined,
      "",
      3,
      "3",
      conversationId,
      `${conversationId}:`,
      `${conversationId}:0`,
      `${conversationId}:-1`,
      `${conversationId}:1.5`,
      `${conversationId}:1e2`,
      `not-a-uuid:3`,
      `:3`,
      null,
    ])
      expect(overviewTaskParamSchema.parse(value)).toBeUndefined();
  });
});

describe("parseOverviewTaskParam", () => {
  test("names the conversation and the Task number", () => {
    expect(parseOverviewTaskParam(`${conversationId}:7`)).toEqual({ conversationId, number: 7 });
  });

  test("names no Task when the popup is closed or the value is malformed", () => {
    expect(parseOverviewTaskParam(undefined)).toBeUndefined();
    expect(parseOverviewTaskParam(`${conversationId}:x`)).toBeUndefined();
  });
});

describe("overviewTaskParam", () => {
  test("writes a Task as its conversation and number, which reads back as the same Task", () => {
    const param = overviewTaskParam({ conversationId, number: 12 });
    expect(param).toBe(`${conversationId}:12`);
    expect(parseOverviewTaskParam(param)).toEqual({ conversationId, number: 12 });
  });
});
