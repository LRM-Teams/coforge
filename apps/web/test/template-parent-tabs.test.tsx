import "./dom-setup";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { RouterContextProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, within } from "@testing-library/react";

import { AppToastProvider } from "@/components/ui/toast";
import { RecordDetail } from "@/features/records/record-detail";
import { overwriteGetLocale } from "@/paraglide/runtime";
import { getRouter } from "@/router";

beforeEach(() => {
  overwriteGetLocale(() => "zh-CN");
});

afterEach(cleanup);

function page() {
  return within(document.body);
}

test("template parent detail exposes overview and template editor tabs", () => {
  render(
    <RouterContextProvider router={getRouter()}>
      <AppToastProvider>
        <RecordDetail
          subject={{
            type: "report",
            report: {
              id: "tpl-1",
              kind: "template",
              title: "2026 W37 工作周报",
              status: "draft",
              content: { markdown: "# 模板正文" },
              author: { userId: "u1", username: "tester", displayName: "Tester" },
              cycle: { id: "c1", year: 2026, week: 37, title: "2026 W37" },
              children: [
                {
                  id: "child-1",
                  title: "Alice 2026 W37 工作周报",
                  status: "draft",
                  author: { userId: "u2", username: "alice", displayName: "Alice" },
                },
              ],
            },
          }}
        />
      </AppToastProvider>
    </RouterContextProvider>,
  );

  expect(page().getByRole("button", { name: "概览" }).getAttribute("aria-current")).toBe("page");
  expect(page().getByRole("link", { name: "Alice" })).toBeTruthy();

  fireEvent.click(page().getByRole("button", { name: "周报模板" }));
  expect(page().getByRole("button", { name: "周报模板" }).getAttribute("aria-current")).toBe(
    "page",
  );
  expect(page().queryByRole("link", { name: "Alice" })).toBeNull();
});
