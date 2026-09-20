import { expect, test } from "bun:test";

import {
  isTemplateChildSubmitted,
  templateChildRows,
  type TemplateChild,
} from "@/features/records/template-children-table";

test("submitted/shared children are clickable; draft is not", () => {
  expect(isTemplateChildSubmitted("draft")).toBe(false);
  expect(isTemplateChildSubmitted("submitted")).toBe(true);
  expect(isTemplateChildSubmitted("shared")).toBe(true);
});

test("maps each template child to name, submitted flag, and submittedAt", () => {
  const children: TemplateChild[] = [
    {
      id: "child-1",
      title: "Alice 2026 W37 工作周报",
      status: "draft",
      submittedAt: null,
      author: { userId: "u1", username: "alice", displayName: "Alice" },
    },
    {
      id: "child-2",
      title: "Bob 2026 W37 工作周报",
      status: "submitted",
      submittedAt: "2026-09-18T08:00:00.000Z",
      author: {
        userId: "u2",
        username: "bob",
        displayName: "Bob",
      },
    },
  ];

  expect(templateChildRows(children)).toEqual([
    {
      id: "child-1",
      name: "Alice",
      submitted: false,
      submittedAt: null,
    },
    {
      id: "child-2",
      name: "Bob",
      submitted: true,
      submittedAt: "2026-09-18T08:00:00.000Z",
    },
  ]);
});

test("returns no rows when the template has no children", () => {
  expect(templateChildRows([])).toEqual([]);
});
