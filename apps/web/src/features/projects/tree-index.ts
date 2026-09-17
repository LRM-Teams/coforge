export type TreeEntryType = "file" | "dir" | "symlink" | "submodule";
export type TreeEntry = { name: string; path: string; type: TreeEntryType; sha: string };
export type TreeIndex = {
  byPath: ReadonlyMap<string, TreeEntry>;
  /** Children per directory path (`""` is the root), directories first, then by name. */
  children: ReadonlyMap<string, readonly TreeEntry[]>;
};

const NO_CHILDREN: readonly TreeEntry[] = [];

/** Indexes GitHub's flat recursive tree once so expanding a folder is a map lookup. */
export function buildTreeIndex(
  entries: ReadonlyArray<{ path: string; type: TreeEntryType; sha: string }>,
): TreeIndex {
  const byPath = new Map<string, TreeEntry>();
  const children = new Map<string, TreeEntry[]>();
  for (const item of entries) {
    const slash = item.path.lastIndexOf("/");
    const entry = { ...item, name: item.path.slice(slash + 1) };
    byPath.set(entry.path, entry);
    const parent = slash === -1 ? "" : item.path.slice(0, slash);
    const siblings = children.get(parent);
    if (siblings) siblings.push(entry);
    else children.set(parent, [entry]);
  }
  for (const siblings of children.values())
    siblings.sort(
      (a, b) => Number(b.type === "dir") - Number(a.type === "dir") || a.name.localeCompare(b.name),
    );
  return { byPath, children };
}

export function childrenOf(index: TreeIndex, path: string): readonly TreeEntry[] {
  return index.children.get(path) ?? NO_CHILDREN;
}

/** `"a/b/c.ts"` → `["a", "a/b"]`: the folders that must be open for the path to be visible. */
export function ancestorPaths(path: string): string[] {
  const segments = path.split("/").slice(0, -1);
  return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
}
