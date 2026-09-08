import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { acquireProcessLock } from "../src/platform/process-lock";

const fixture = new URL("fixtures/process-lock-child.ts", import.meta.url).pathname;
const roots: string[] = [];
const children = new Set<Bun.Subprocess>();

afterEach(async () => {
  for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
  await Promise.all([...children].map((child) => child.exited));
  children.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function lockPath() {
  const root = await mkdtemp(join(tmpdir(), "coforge-process-lock-"));
  roots.push(root);
  return join(root, "mutex.sqlite");
}

function contender(path: string) {
  const child = Bun.spawn([process.execPath, fixture, "contend", path], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  children.add(child);
  return child;
}

async function line(child: Bun.Subprocess): Promise<string> {
  if (!(child.stdout instanceof ReadableStream)) throw new Error("child stdout is not piped");
  const reader = child.stdout.getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  return new TextDecoder().decode(value).trim();
}

test("simultaneous processes have exactly one lock owner", async () => {
  const path = await lockPath();
  const contenders = Array.from({ length: 8 }, () => contender(path));
  expect(await Promise.all(contenders.map(line))).toEqual(Array(8).fill("ready"));
  for (const child of contenders) child.stdin.write("go\n");
  const outcomes = await Promise.all(contenders.map(line));
  expect(outcomes.filter((value) => value === "acquired")).toHaveLength(1);
  expect(outcomes.filter((value) => value === "contended")).toHaveLength(7);
  contenders.find((_, index) => outcomes[index] === "acquired")!.stdin.write("release\n");
});

test("SIGKILL releases ownership and preserves the permanent lock inode", async () => {
  const path = await lockPath();
  const owner = contender(path);
  expect(await line(owner)).toBe("ready");
  owner.stdin.write("go\n");
  expect(await line(owner)).toBe("acquired");
  const inode = (await stat(path)).ino;
  owner.kill("SIGKILL");
  await owner.exited;

  const contenders = Array.from({ length: 6 }, () => contender(path));
  await Promise.all(contenders.map(line));
  for (const child of contenders) child.stdin.write("go\n");
  const outcomes = await Promise.all(contenders.map(line));
  expect(outcomes.filter((value) => value === "acquired")).toHaveLength(1);
  expect((await stat(path)).ino).toBe(inode);
  contenders.find((_, index) => outcomes[index] === "acquired")!.stdin.write("release\n");
});

test("spawned child does not retain its parent's lock", async () => {
  const path = await lockPath();
  const owner = Bun.spawn([process.execPath, fixture, "spawn-child", path], {
    stdout: "pipe",
    stderr: "inherit",
  });
  children.add(owner);
  const childPid = Number((await line(owner)).slice("child:".length));
  await owner.exited;
  const lock = acquireProcessLock(path);
  lock.release();
  process.kill(childPid, "SIGKILL");
});

test("clean and startup-failure paths release the lock", async () => {
  const path = await lockPath();
  const lock = acquireProcessLock(path);
  lock.release();
  expect(() => acquireProcessLock(path).release()).not.toThrow();

  const failed = Bun.spawn([process.execPath, fixture, "fail", path], { stderr: "ignore" });
  children.add(failed);
  expect(await failed.exited).not.toBe(0);
  expect(() => acquireProcessLock(path).release()).not.toThrow();
});

test("supervisor startup failure releases its process lock", async () => {
  const path = await lockPath();
  const stateDirectory = join(dirname(path), "state");
  await mkdir(stateDirectory);
  await writeFile(join(stateDirectory, "bindings.json"), "not-json");
  const failed = Bun.spawn([process.execPath, fixture, "supervisor-fail", stateDirectory], {
    stderr: "ignore",
  });
  children.add(failed);
  expect(await failed.exited).not.toBe(0);
  expect(() =>
    acquireProcessLock(join(stateDirectory, "supervisor-lock.sqlite")).release(),
  ).not.toThrow();
});
