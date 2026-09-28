import { expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { createPromptFile } from "#src/code-agent/claude-code/prompt-file";

test("a session's instructions are written where only this user can read them", async () => {
  const prompt = await createPromptFile("be helpful");

  expect(await readFile(prompt.path, "utf8")).toBe("be helpful");
  expect((await stat(prompt.path)).mode & 0o777).toBe(0o600);

  await prompt.remove();
  await expect(stat(prompt.path)).rejects.toThrow();
});

test("removing the prompt more than once removes it once", async () => {
  const removed: string[] = [];
  const prompt = await createPromptFile("be helpful", async (path) => {
    removed.push(String(path));
  });

  // A session that exits and is then disposed asks twice, the first time without waiting. Two
  // recursive removes walking one directory at once is what made dispose fail with EPERM.
  await Promise.all([prompt.remove(), prompt.remove(), prompt.remove()]);

  expect(removed).toEqual([dirname(prompt.path)]);
});

test("a removal that fails is reported to every caller rather than to none", async () => {
  const prompt = await createPromptFile("be helpful", async () => {
    throw new Error("the prompt directory could not be removed");
  });

  await expect(prompt.remove()).rejects.toThrow("could not be removed");
  await expect(prompt.remove()).rejects.toThrow("could not be removed");
});
