import { expect, test } from "bun:test";

import { templateChildRows, type TemplateChild } from "@/features/records/template-children-table";

test("maps each template child to a name cell from the child author", () => {
  const children: TemplateChild[] = [
    {
      id: "child-1",
      title: "Alice 2026 W37 工作周报",
      status: "draft",
      author: { userId: "u1", username: "alice", displayName: "Alice" },
    },
    {
      id: "child-2",
      title: "lijiannankai-95827c9b 2026 W37 工作周报",
      status: "submitted",
      author: {
        userId: "u2",
        username: "lijiannankai-95827c9b",
        displayName: "lijiannankai-95827c9b",
      },
    },
  ];

  expect(templateChildRows(children)).toEqual([
    { id: "child-1", name: "Alice" },
    { id: "child-2", name: "lijiannankai-95827c9b" },
  ]);
});

test("returns no rows when the template has no children", () => {
  expect(templateChildRows([])).toEqual([]);
});
