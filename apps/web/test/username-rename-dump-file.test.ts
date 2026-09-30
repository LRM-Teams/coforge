import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RENAME_DUMP_FORMAT,
  parseUsernameRenameDump,
  type UsernameRenameDump,
} from "#src/server/auth/username-rename-dump.server";
import {
  UsernameRenameDumpFile,
  describeFailedRename,
  readUsernameRenameDumpFile,
} from "#src/server/auth/username-rename-dump-file.server";

/**
 * The dump is the only way back from a rename, so its file is written once, readable by its owner
 * only, and never replaced; a rename that failed leaves it set aside as what it is: not a way back.
 */

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "username-rename-dump-"));
  directories.push(path);
  return path;
}

const dump: UsernameRenameDump = {
  format: RENAME_DUMP_FORMAT,
  createdAt: "2026-09-30T00:00:00.000Z",
  renames: [{ userId: "u1", from: "ada-1234abcd", to: "ada", source: "email" }],
  rows: {
    users: [{ id: "u1", username: "ada-1234abcd" }],
    messageMentions: [],
    taskHistoryEvents: [],
    taskHistoryPayloads: [],
    pendingMentionActions: [],
    reminders: [],
  },
};

test("a dump is written as JSON that reads back, for its owner only", async () => {
  const path = join(await directory(), "dump.json");

  await new UsernameRenameDumpFile(path).write(dump);

  expect(parseUsernameRenameDump(await readFile(path, "utf8"))).toEqual(dump);
  expect(await readUsernameRenameDumpFile(path)).toEqual(dump);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});

test("a file that is already there is never replaced, and the refusal says why", async () => {
  const path = join(await directory(), "dump.json");
  await writeFile(path, "an earlier dump");
  const file = new UsernameRenameDumpFile(path);

  await expect(file.write(dump)).rejects.toThrow(
    `${path} already exists: a dump is never overwritten, name a new file`,
  );

  expect(await readFile(path, "utf8")).toBe("an earlier dump");
  // It was not this run's file, so it is not this run's to move.
  expect(await file.setAsideAsFailed()).toBeUndefined();
  expect(await readFile(path, "utf8")).toBe("an earlier dump");
});

test("after a failed rename the dump it wrote is set aside as <name>.failed.json", async () => {
  const dir = await directory();
  const file = new UsernameRenameDumpFile(join(dir, "dump.json"));
  await file.write(dump);

  const failed = await file.setAsideAsFailed();

  expect(failed).toBe(join(dir, "dump.failed.json"));
  expect((await readdir(dir)).sort()).toEqual(["dump.failed.json"]);
  expect(await readUsernameRenameDumpFile(failed!)).toEqual(dump);
});

test("a name without .json gets .failed.json, and an earlier failed dump is kept", async () => {
  const dir = await directory();
  await writeFile(join(dir, "dump.failed.json"), "the first failure");
  const file = new UsernameRenameDumpFile(join(dir, "dump"));
  await file.write(dump);

  const failed = await file.setAsideAsFailed();

  expect(failed).toBe(join(dir, "dump.failed-2.json"));
  expect(await readFile(join(dir, "dump.failed.json"), "utf8")).toBe("the first failure");
});

test("a rename that wrote no dump has nothing to set aside", async () => {
  const dir = await directory();

  expect(
    await new UsernameRenameDumpFile(join(dir, "dump.json")).setAsideAsFailed(),
  ).toBeUndefined();
  expect(await readdir(dir)).toEqual([]);
});

test("a file that is not a dump this script wrote is refused", async () => {
  const path = join(await directory(), "other.json");
  await writeFile(path, JSON.stringify({ format: "something-else" }));

  await expect(readUsernameRenameDumpFile(path)).rejects.toThrow(
    `${path} is not a username rename dump written by this script`,
  );
});

test("a dump file that is not there is reported by its path", async () => {
  const path = join(await directory(), "missing.json");

  await expect(readUsernameRenameDumpFile(path)).rejects.toThrow(`${path} does not exist`);
});

test("a failed rename is reported first, then what became of its dump", async () => {
  const dir = await directory();
  const file = new UsernameRenameDumpFile(join(dir, "dump.json"));
  await file.write(dump);

  const message = await describeFailedRename(file, new Error("the rename broke 1 rule(s)"));

  expect(message).toBe(
    `the rename broke 1 rule(s)\nthe dump was moved to ${join(dir, "dump.failed.json")}: the rename changed nothing, so it is not a way back`,
  );
});

test("a failed rename that wrote no dump is reported as it is", async () => {
  const file = new UsernameRenameDumpFile(join(await directory(), "dump.json"));

  expect(await describeFailedRename(file, new Error("the plan could not be read"))).toBe(
    "the plan could not be read",
  );
  expect(await describeFailedRename(file, "not an Error")).toBe("not an Error");
});

test("a dump that cannot be set aside does not hide the error that failed the rename", async () => {
  const stuck = {
    path: "/data/dump.json",
    setAsideAsFailed: async () => {
      throw new Error("EACCES: permission denied, rename '/data/dump.json'");
    },
  };

  const message = await describeFailedRename(stuck, new Error("the rename broke 1 rule(s)"));

  expect(message.split("\n")[0]).toBe("the rename broke 1 rule(s)");
  expect(message).toContain("/data/dump.json could not be moved aside");
  expect(message).toContain("EACCES: permission denied");
  expect(message).toContain("the rename changed nothing, so do not restore it");
});
