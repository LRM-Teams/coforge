import { expect, test } from "bun:test";
import {
  replaceTaskReferenceTokens,
  resolveTaskReferences,
  taskReferenceNumbers,
  taskReferenceToken,
} from "./task-references";

test("taskReferenceNumbers reads prose references outside code, deduped in first-seen order", () => {
  const body = "pairs with task #68 and task #70, again task #68, and `task #99` in code";
  expect(taskReferenceNumbers(body)).toEqual([68, 70]);
});

test("taskReferenceNumbers ignores a bare #68 and a longer word", () => {
  expect(taskReferenceNumbers("#68 on its own")).toEqual([]);
  expect(taskReferenceNumbers("mytask #5")).toEqual([]);
  // The number is read as one token: `#680` is task 680, not task 68 followed by a zero.
  expect(taskReferenceNumbers("task #680")).toEqual([680]);
});

test("taskReferenceNumbers is case-insensitive about the word task", () => {
  expect(taskReferenceNumbers("Task #5")).toEqual([5]);
});

test("resolveTaskReferences tokenizes only numbers that name a real task", () => {
  const { body, references } = resolveTaskReferences(
    "task #68 and task #999 and task #70",
    (number) => number === 68 || number === 70,
  );
  expect(body).toBe(`${taskReferenceToken(68)} and task #999 and ${taskReferenceToken(70)}`);
  expect(references).toEqual([68, 70]);
});

test("resolveTaskReferences leaves code spans byte-for-byte intact", () => {
  const source = "see `task #68` and ```\ntask #68\n``` and task #68";
  const { body } = resolveTaskReferences(source, () => true);
  expect(body).toBe(`see \`task #68\` and \`\`\`\ntask #68\n\`\`\` and ${taskReferenceToken(68)}`);
});

test("replaceTaskReferenceTokens resolves known tokens and keeps unknown ones intact", () => {
  const body = `${taskReferenceToken(68)} and ${taskReferenceToken(999)}`;
  expect(
    replaceTaskReferenceTokens(body, (number) => (number === 68 ? `task #${number}` : undefined)),
  ).toBe("task #68 and <@task:999>");
});

test("replaceTaskReferenceTokens round-trips resolveTaskReferences output", () => {
  const { body } = resolveTaskReferences("refer to task #7", () => true);
  expect(replaceTaskReferenceTokens(body, (number) => `task #${number}`)).toBe("refer to task #7");
});
