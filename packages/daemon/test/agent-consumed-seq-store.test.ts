import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentConsumedSeqStore } from "#src/persistence/agent-consumed-seq-store";

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

/** Raft's location for the cursor is `tmpdir()/slock-cli-consumed-seq/<agentId>/consumed-seqs.json`
 * (`SLOCK_CLI_CONSUMED_SEQ_STATE_DIR` overrides the root); CoForge's is the same idea with its own
 * directory name, next to the draft store — so a state directory is the root here, and the two
 * directory levels below it are the store's own. */
const storeDirectory = (root: string, agentId = "agent-1") =>
  join(
    root,
    `coforge-cli-consumed-seq-${encodeURIComponent(String(process.geteuid?.() ?? "")).replaceAll(".", "%2E")}`,
    agentId,
  );
const storePath = (root: string, agentId = "agent-1") =>
  join(storeDirectory(root, agentId), "consumed-seqs.json");

test("writes one snapshot in Raft 1.0.38's consumed-seqs shape and reads it back", async () => {
  const stateDirectory = temporaryStateDirectory();
  const store = new AgentConsumedSeqStore(stateDirectory);
  const state = {
    targets: {
      "@ada": { seq: 7, exactSeqs: [9, 12] },
      "#general:abcd1234": { readOrder: 1, reviewedSeq: 3 },
    },
    aliases: { "#general:ABCD1234": "#general:abcd1234" },
    nextReadOrder: 2,
  };

  store.write("agent-1", state);

  expect(JSON.parse(await readFile(storePath(stateDirectory), "utf8"))).toEqual(state);
  expect(new AgentConsumedSeqStore(stateDirectory).read("agent-1")).toEqual(state);
});

test("reading a file nobody in this process wrote normalizes its exact sequences", async () => {
  const stateDirectory = temporaryStateDirectory();
  await mkdir(storeDirectory(stateDirectory), { recursive: true });
  await writeFile(
    storePath(stateDirectory),
    JSON.stringify({
      targets: {
        // Duplicates, non-integers and sequences at or below the frontier are not kept.
        "@ada": { seq: 4, exactSeqs: [9, 6, 6, 3, 4, 2.5, "7"] },
        // An entry that carries only exact sequences is kept.
        "#general": { exactSeqs: [12] },
        "@bea": { exactSeqs: Array.from({ length: 2600 }, (_, index) => index + 1) },
      },
    }),
  );

  const targets = new AgentConsumedSeqStore(stateDirectory).read("agent-1").targets;
  expect(targets["@ada"]).toEqual({ seq: 4, exactSeqs: [6, 9] });
  expect(targets["#general"]).toEqual({ exactSeqs: [12] });
  const kept = targets["@bea"]?.exactSeqs ?? [];
  expect([kept.length, kept[0], kept.at(-1)]).toEqual([2500, 101, 2600]);
});

test("reading compresses alias chains to their canonical target and drops a cycle", async () => {
  const stateDirectory = temporaryStateDirectory();
  await mkdir(storeDirectory(stateDirectory), { recursive: true });
  await writeFile(
    storePath(stateDirectory),
    JSON.stringify({
      targets: {},
      aliases: { a: "b", b: "c", same: "same", x: "y", y: "x" },
    }),
  );

  expect(new AgentConsumedSeqStore(stateDirectory).read("agent-1").aliases).toEqual({
    a: "c",
    b: "c",
  });
});

test("recomputes nextReadOrder from the orders the file holds, never trusting the stored one", async () => {
  const stateDirectory = temporaryStateDirectory();
  await mkdir(storeDirectory(stateDirectory), { recursive: true });
  // A file whose `nextReadOrder` is behind the orders it carries — an older build's write, or an
  // edit. Raft's `normalizeState` starts the counter above everything it saw.
  await writeFile(
    storePath(stateDirectory),
    JSON.stringify({ targets: { "@ada": { readOrder: 12 } }, nextReadOrder: 2 }),
  );

  expect(new AgentConsumedSeqStore(stateDirectory).read("agent-1").nextReadOrder).toBe(13);
});

test("a missing, unreadable or shapeless file is an empty cursor, never an error", async () => {
  const stateDirectory = temporaryStateDirectory();
  const store = new AgentConsumedSeqStore(stateDirectory);
  const empty = { targets: {}, aliases: {}, nextReadOrder: 1 };
  expect(store.read("agent-1")).toEqual(empty);

  await mkdir(storeDirectory(stateDirectory), { recursive: true });
  await writeFile(storePath(stateDirectory), "{ this is not json");
  expect(store.read("agent-1")).toEqual(empty);

  // Entries that carry neither a sequence nor an order are dropped rather than kept as garbage.
  await writeFile(
    storePath(stateDirectory),
    JSON.stringify({ targets: { "@ada": {}, "@bea": "nope", "@cara": { seq: 0, readOrder: -1 } } }),
  );
  expect(store.read("agent-1")).toEqual(empty);
});

test("an unwritable cursor is reported, not thrown: a lost cursor must not fail a send", async () => {
  const stateDirectory = temporaryStateDirectory();
  // The state root is a file, so the directory the cursor needs cannot exist.
  await writeFile(stateDirectory, "not a directory");
  const store = new AgentConsumedSeqStore(stateDirectory);

  expect(() =>
    store.write("agent-1", { targets: { "@ada": { seq: 3 } }, aliases: {}, nextReadOrder: 1 }),
  ).not.toThrow();
  expect(store.read("agent-1")).toEqual({ targets: {}, aliases: {}, nextReadOrder: 1 });
});

test("an Agent id that could not be a path segment is refused", () => {
  const store = new AgentConsumedSeqStore(temporaryStateDirectory());
  expect(() => store.read("../../etc")).toThrow("invalid consumed-sequence Agent scope");
  expect(() => store.write("", { targets: {}, aliases: {}, nextReadOrder: 1 })).toThrow(
    "invalid consumed-sequence Agent scope",
  );
});

test("leaves no temporary file behind once a cursor has been written", async () => {
  const stateDirectory = temporaryStateDirectory();
  const store = new AgentConsumedSeqStore(stateDirectory);
  store.write("agent-1", { targets: { "@ada": { seq: 1 } }, aliases: {}, nextReadOrder: 1 });

  expect((await readdir(storeDirectory(stateDirectory))).sort()).toEqual(["consumed-seqs.json"]);
});
