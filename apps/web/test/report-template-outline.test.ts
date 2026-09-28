import { expect, test } from "bun:test";

import {
  dropEdgeFromClientY,
  moveOutlineNodes,
  parseOutline,
  serializeOutline,
  type OutlineNode,
} from "#src/features/records/report-template-outline";

test("dropEdgeFromClientY uses the row midpoint", () => {
  expect(dropEdgeFromClientY(10, 0, 40)).toBe("before");
  expect(dropEdgeFromClientY(30, 0, 40)).toBe("after");
});

test("moveOutlineNodes inserts a body row before the drop target", () => {
  const nodes = parseOutline("## A\nbody-a\n## B\nbody-b");
  const bodyB = nodes.find((node) => node.kind === "body" && node.text === "body-b")!;
  const headingB = nodes.find((node) => node.kind === "heading" && node.text === "B")!;

  const next = moveOutlineNodes(nodes, bodyB.id, headingB.id, "before");

  expect(serializeOutline(next)).toBe("## A\nbody-a\nbody-b\n## B");
});

test("moveOutlineNodes inserts a body row after the drop target", () => {
  const nodes = parseOutline("## A\nbody-a\n## B\nbody-b");
  const bodyB = nodes.find((node) => node.kind === "body" && node.text === "body-b")!;
  const headingA = nodes.find((node) => node.kind === "heading" && node.text === "A")!;

  const next = moveOutlineNodes(nodes, bodyB.id, headingA.id, "after");

  expect(serializeOutline(next)).toBe("## A\nbody-b\nbody-a\n## B");
});

test("moveOutlineNodes moves a heading with its descendant subtree", () => {
  const nodes = parseOutline("# Parent\n## Child\nbody\n# Sibling\nother");
  const parent = nodes.find((node) => node.kind === "heading" && node.text === "Parent")!;
  const sibling = nodes.find((node) => node.kind === "heading" && node.text === "Sibling")!;

  const next = moveOutlineNodes(nodes, sibling.id, parent.id);

  expect(serializeOutline(next)).toBe("# Sibling\nother\n# Parent\n## Child\nbody");
});

test("moveOutlineNodes ignores drops inside the dragged heading subtree", () => {
  const nodes = parseOutline("# Parent\n## Child\nbody");
  const parent = nodes.find((node) => node.kind === "heading" && node.text === "Parent")!;
  const child = nodes.find((node) => node.kind === "heading" && node.text === "Child")!;
  const before: OutlineNode[] = nodes.map((node) => ({ ...node }));

  expect(moveOutlineNodes(nodes, parent.id, child.id)).toEqual(before);
});
