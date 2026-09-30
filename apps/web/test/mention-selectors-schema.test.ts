import { expect, test } from "bun:test";

import { mentionSelectorsSchema } from "#src/features/conversations/conversation.schemas";

const ID = "550e8400-e29b-41d4-a716-446655440000";

test("the browser's mention bindings take the Agent API's shape: a kind, an actor id and a handle", () => {
  const bindings: { type: "user" | "agent"; id: string; name: string }[] = [
    { type: "user", id: ID, name: "zhangsan" },
    { type: "agent", id: ID, name: "code-reviewer" },
  ];
  expect(mentionSelectorsSchema.parse(bindings)).toEqual(bindings);
  expect(mentionSelectorsSchema.parse(undefined)).toBeUndefined();
});

test("a binding whose handle, id or kind breaks the handle grammar is refused", () => {
  const refused = (binding: unknown) =>
    mentionSelectorsSchema.safeParse([binding]).success === false;
  expect(refused({ type: "user", id: ID, name: "Zhang San" })).toBe(true);
  expect(refused({ type: "user", id: ID, name: "张三" })).toBe(true);
  expect(refused({ type: "user", id: ID, name: "-zhang" })).toBe(true);
  expect(refused({ type: "user", id: ID, name: "a".repeat(129) })).toBe(true);
  expect(refused({ type: "user", id: "not-a-uuid", name: "zhangsan" })).toBe(true);
  expect(refused({ type: "human", id: ID, name: "zhangsan" })).toBe(true);
});

test("a send carries at most as many bindings as the Agent API allows", () => {
  const binding = { type: "user", id: ID, name: "zhangsan" };
  expect(mentionSelectorsSchema.safeParse(Array(32).fill(binding)).success).toBe(true);
  expect(mentionSelectorsSchema.safeParse(Array(33).fill(binding)).success).toBe(false);
});
