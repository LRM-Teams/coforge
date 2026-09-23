import { expect, test } from "bun:test";
import { ancestorPaths, buildTreeIndex, childrenOf } from "#src/features/projects/tree-index";

const sha = "a".repeat(40);

test("indexes GitHub's flat tree into sorted children per directory", () => {
  const index = buildTreeIndex([
    { path: "zeta.md", type: "file", sha },
    { path: "docs", type: "dir", sha },
    { path: "docs/b.md", type: "file", sha },
    { path: "docs/adr", type: "dir", sha },
    { path: "docs/a.md", type: "file", sha },
    { path: "alpha.ts", type: "file", sha },
  ]);
  expect(childrenOf(index, "").map((entry) => entry.name)).toEqual(["docs", "alpha.ts", "zeta.md"]);
  expect(childrenOf(index, "docs").map((entry) => entry.path)).toEqual([
    "docs/adr",
    "docs/a.md",
    "docs/b.md",
  ]);
  expect(childrenOf(index, "docs/adr")).toEqual([]);
  expect(index.byPath.get("docs/a.md")).toEqual({
    name: "a.md",
    path: "docs/a.md",
    type: "file",
    sha,
  });
});

test("ancestorPaths lists the folders that reveal a path", () => {
  expect(ancestorPaths("a/b/c.ts")).toEqual(["a", "a/b"]);
  expect(ancestorPaths("top.ts")).toEqual([]);
  expect(ancestorPaths("")).toEqual([]);
});
