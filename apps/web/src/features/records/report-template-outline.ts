const MAX_LEVEL = 5;
export type HeadingLevel = 1 | 2 | 3 | 4 | 5;
export type OutlineNode =
  | { id: number; kind: "heading"; level: HeadingLevel; text: string }
  | { id: number; kind: "body"; text: string };

export function parseOutline(markdown: string): OutlineNode[] {
  if (!markdown) return [];
  const lines = markdown.endsWith("\n") ? markdown.slice(0, -1).split("\n") : markdown.split("\n");
  return lines.map((line, id) => {
    const heading = line.match(/^(#{1,5})\s+(.+)$/);
    if (!heading) return { id, kind: "body", text: line };
    return {
      id,
      kind: "heading",
      level: Math.min(heading[1]!.length, MAX_LEVEL) as HeadingLevel,
      text: heading[2]!.trim(),
    };
  });
}

export function serializeOutline(nodes: OutlineNode[]) {
  const markdown = nodes
    .map((node) => (node.kind === "body" ? node.text : `${"#".repeat(node.level)} ${node.text}`))
    .join("\n");
  return nodes.at(-1)?.kind === "body" && nodes.at(-1)?.text === "" ? `${markdown}\n` : markdown;
}

export function subtreeRange(nodes: OutlineNode[], index: number): { start: number; end: number } {
  const node = nodes[index];
  if (!node) return { start: index, end: index };
  if (node.kind === "body") return { start: index, end: index + 1 };
  let end = index + 1;
  while (end < nodes.length) {
    const candidate = nodes[end];
    if (!candidate) break;
    if (candidate.kind === "heading" && candidate.level <= node.level) break;
    end += 1;
  }
  return { start: index, end };
}

export type DropEdge = "before" | "after";

export function dropEdgeFromClientY(clientY: number, rowTop: number, rowHeight: number): DropEdge {
  return clientY < rowTop + rowHeight / 2 ? "before" : "after";
}

/** Move the source row (heading + descendants when applicable) to before/after the target row. */
export function moveOutlineNodes(
  nodes: OutlineNode[],
  sourceId: number,
  targetId: number,
  edge: DropEdge = "before",
): OutlineNode[] {
  const sourceIndex = nodes.findIndex((node) => node.id === sourceId);
  const targetIndex = nodes.findIndex((node) => node.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0) return nodes;

  const { start, end } = subtreeRange(nodes, sourceIndex);
  if (targetIndex >= start && targetIndex < end) return nodes;

  const block = nodes.slice(start, end);
  const without = [...nodes.slice(0, start), ...nodes.slice(end)];
  const targetAt = without.findIndex((node) => node.id === targetId);
  if (targetAt < 0) return nodes;
  const insertAt = edge === "after" ? targetAt + 1 : targetAt;
  return [...without.slice(0, insertAt), ...block, ...without.slice(insertAt)];
}

export { MAX_LEVEL };
