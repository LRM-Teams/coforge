import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** One code-agent session's system-prompt file, and the removal of the directory holding it. */
export type PromptFile = {
  /** The path to pass to the code agent as its appended system prompt. */
  readonly path: string;
  /**
   * Removes the directory. A session asks more than once - when its process closes, and again
   * when it is disposed - and the two used to be separate recursive removes walking the same
   * directory at once, which on macOS failed the second one with EPERM (`force` suppresses a
   * missing path, not a directory that vanishes mid-walk), so disposing a session that had
   * exited normally threw. Every call now waits on the same single removal.
   */
  remove(): Promise<void>;
};

/** Writes `instructions` to a fresh private directory. `remove` is injectable for tests. */
export async function createPromptFile(
  instructions: string,
  remove: (path: string) => Promise<void> = (path) => rm(path, { recursive: true, force: true }),
): Promise<PromptFile> {
  const directory = await mkdtemp(join(tmpdir(), "coforge-claude-prompt-"));
  const path = join(directory, "system-prompt.md");
  await writeFile(path, instructions, { mode: 0o600 });
  let removal: Promise<void> | undefined;
  return {
    path,
    remove: () => (removal ??= remove(directory)),
  };
}
