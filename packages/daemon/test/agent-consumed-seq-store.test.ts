import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentConsumedSeqStore } from "../src/persistence/agent-consumed-seq-store";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const temporaryStateDirectory = () => {
  const path = join(tmpdir(), `coforge-consumed-seqs-${crypto.randomUUID()}`);
  directories.push(path);
  return path;
};

const storePath = (stateDirectory: string, agentId = "agent-1") =>
  join(stateDirectory, "agent-consumed-seqs", "workspace-1", agentId, "consumed-seqs.json");

test("persists the consumed cursor in Raft's consumed-seqs shape", async () => {
  const stateDirectory = temporaryStateDirectory();
  const store = new AgentConsumedSeqStore(stateDirectory, "workspace-1");

  store.recordConsumedSeqs("agent-1", { "@ada": 7 });
  store.recordConsumedRead("agent-1", "#general:abcd1234");

  // Raft's `consumed-seqs.json`: `targets` keyed by target, each entry carrying `seq` (the consumed
  // frontier) and `readOrder` (when the target was reviewed, ordered against every other target),
  // plus the next `readOrder` to hand out.
  expect(JSON.parse(await readFile(storePath(stateDirectory), "utf8"))).toEqual({
    targets: {
      "@ada": { seq: 7, readOrder: 1 },
      "#general:abcd1234": { readOrder: 2 },
    },
    nextReadOrder: 3,
  });
});

test("a lower sequence never lowers a cursor, and every record takes a new read order", async () => {
  const stateDirectory = temporaryStateDirectory();
  const store = new AgentConsumedSeqStore(stateDirectory, "workspace-1");

  store.recordConsumedSeqs("agent-1", { "@ada": 9 });
  store.recordConsumedSeqs("agent-1", { "@ada": 4 });
  store.recordConsumedRead("agent-1", "@ada", 5);

  expect(store.read("agent-1").targets["@ada"]).toEqual({ seq: 9, readOrder: 3 });
  expect(store.read("agent-1").nextReadOrder).toBe(4);
});

test("recomputes nextReadOrder from the orders the file holds, never trusting the stored one", async () => {
  const stateDirectory = temporaryStateDirectory();
  const path = storePath(stateDirectory);
  await mkdir(join(stateDirectory, "agent-consumed-seqs", "workspace-1", "agent-1"), {
    recursive: true,
  });
  // A file whose `nextReadOrder` is behind the orders it carries — an older build's write, or an
  // edit. Raft's `normalizeState` starts the counter above everything it saw.
  await writeFile(
    path,
    JSON.stringify({ targets: { "@ada": { readOrder: 12 } }, nextReadOrder: 2 }),
  );

  const store = new AgentConsumedSeqStore(stateDirectory, "workspace-1");
  expect(store.read("agent-1").nextReadOrder).toBe(13);

  store.recordConsumedRead("agent-1", "@bea");
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
    targets: { "@bea": { readOrder: 13 } },
    nextReadOrder: 14,
  });
});

test("a missing, unreadable or shapeless file is an empty cursor, never an error", async () => {
  const stateDirectory = temporaryStateDirectory();
  const store = new AgentConsumedSeqStore(stateDirectory, "workspace-1");
  expect(store.read("agent-1")).toEqual({ targets: {}, nextReadOrder: 1 });

  await mkdir(join(stateDirectory, "agent-consumed-seqs", "workspace-1", "agent-1"), {
    recursive: true,
  });
  await writeFile(storePath(stateDirectory), "{ this is not json");
  expect(store.read("agent-1")).toEqual({ targets: {}, nextReadOrder: 1 });

  // Entries that carry neither a sequence nor an order are dropped rather than kept as garbage.
  await writeFile(
    storePath(stateDirectory),
    JSON.stringify({ targets: { "@ada": {}, "@bea": "nope", "@cara": { seq: 0, readOrder: -1 } } }),
  );
  expect(store.read("agent-1")).toEqual({ targets: {}, nextReadOrder: 1 });
});

test("an unwritable cursor is reported, not thrown: a lost cursor must not fail a send", async () => {
  const stateDirectory = temporaryStateDirectory();
  // The state root is a file, so the directory the cursor needs cannot exist.
  await writeFile(stateDirectory, "not a directory");
  const store = new AgentConsumedSeqStore(stateDirectory, "workspace-1");

  expect(() => store.recordConsumedSeqs("agent-1", { "@ada": 3 })).not.toThrow();
  expect(() => store.recordConsumedRead("agent-1", "@ada", 4)).not.toThrow();
  expect(store.read("agent-1")).toEqual({ targets: {}, nextReadOrder: 1 });
});

test("an Agent id that could not be a path segment is refused", () => {
  const store = new AgentConsumedSeqStore(temporaryStateDirectory(), "workspace-1");
  expect(() => store.read("../../etc")).toThrow("invalid consumed-sequence Agent scope");
  expect(() => store.recordConsumedRead("", "@ada")).toThrow(
    "invalid consumed-sequence Agent scope",
  );
});

test("leaves no temporary file behind once a cursor has been written", async () => {
  const stateDirectory = temporaryStateDirectory();
  const store = new AgentConsumedSeqStore(stateDirectory, "workspace-1");
  store.recordConsumedSeqs("agent-1", { "@ada": 1 });

  expect(
    (await readdir(join(stateDirectory, "agent-consumed-seqs", "workspace-1", "agent-1"))).sort(),
  ).toEqual(["consumed-seqs.json"]);
});
