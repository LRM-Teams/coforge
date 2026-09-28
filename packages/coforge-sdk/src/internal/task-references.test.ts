import { expect, test } from "bun:test";
import { replaceTaskReferenceTokens, taskReferenceToken } from "./task-references";

test("replaceTaskReferenceTokens resolves known tokens and keeps unknown ones intact", () => {
  const body = `${taskReferenceToken(68)} and ${taskReferenceToken(999)}`;
  expect(
    replaceTaskReferenceTokens(body, (number) => (number === 68 ? `task #${number}` : undefined)),
  ).toBe("task #68 and <@task:999>");
});
