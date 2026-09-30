import { readFile, rename, writeFile } from "node:fs/promises";
import {
  parseUsernameRenameDump,
  serializeUsernameRenameDump,
  type UsernameRenameDump,
} from "./username-rename-dump.server";

/**
 * A dump on disk. It is the only way back from a rename, so it is written once, for its owner only
 * (`wx`, mode 0600), and never replaced. `write` is what `renameUsernames` calls with the dump,
 * before it changes anything; if the rename then fails, nothing was changed and the dump describes
 * a rename that never happened, so `setAsideAsFailed` moves it out of the way of a restore.
 */
export class UsernameRenameDumpFile {
  #written = false;

  constructor(readonly path: string) {}

  readonly write = async (dump: UsernameRenameDump): Promise<void> => {
    try {
      await writeFile(this.path, serializeUsernameRenameDump(dump), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error(
          `${this.path} already exists: a dump is never overwritten, name a new file`,
        );
      throw error;
    }
    this.#written = true;
  };

  /**
   * Renames the dump this run wrote to `<name>.failed.json` (`.failed-2.json` and on, never over
   * an earlier one) and returns the new path; undefined when this run wrote none.
   */
  async setAsideAsFailed(): Promise<string | undefined> {
    if (!this.#written) return undefined;
    const stem = this.path.replace(/\.json$/, "");
    for (let attempt = 1; ; attempt += 1) {
      const target = `${stem}.failed${attempt === 1 ? "" : `-${attempt}`}.json`;
      if (await Bun.file(target).exists()) continue;
      await rename(this.path, target);
      this.#written = false;
      return target;
    }
  }
}

/** Reads a dump file, and says in plain words when it is missing or is not one. */
export async function readUsernameRenameDumpFile(path: string): Promise<UsernameRenameDump> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`${path} does not exist`);
    throw error;
  }
  try {
    return parseUsernameRenameDump(text);
  } catch {
    throw new Error(`${path} is not a username rename dump written by this script`);
  }
}

/**
 * What to tell the operator when the rename failed: the error that failed it, first and whole, then
 * what became of the dump. Setting the dump aside can fail too (a read-only directory), and that
 * must not hide the error that mattered.
 */
export async function describeFailedRename(
  file: Pick<UsernameRenameDumpFile, "path" | "setAsideAsFailed">,
  error: unknown,
): Promise<string> {
  const reason = error instanceof Error ? error.message : String(error);
  try {
    const failed = await file.setAsideAsFailed();
    return failed
      ? `${reason}\nthe dump was moved to ${failed}: the rename changed nothing, so it is not a way back`
      : reason;
  } catch (aside) {
    const why = aside instanceof Error ? aside.message : String(aside);
    return `${reason}\n${file.path} could not be moved aside (${why}): the rename changed nothing, so do not restore it`;
  }
}
