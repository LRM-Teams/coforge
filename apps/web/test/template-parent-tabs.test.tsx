import "./dom-setup";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { RouterContextProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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

test("template parent detail exposes overview and template editor tabs", async () => {
  const user = userEvent.setup({ document });
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
  expect(page().getByRole("button", { name: "Summary" })).toBeTruthy();
  expect(page().getByRole("button", { name: "添加标题" })).toBeTruthy();
  expect(page().getByRole("button", { name: "+ 正文" })).toBeTruthy();

  await user.click(page().getByRole("button", { name: "添加标题" }));
  await user.click(page().getByRole("menuitem", { name: "+ 二级标题" }));
  const secondLevel = page().getByDisplayValue("二级标题");
  expect(secondLevel.className).toContain("text-xl");
  expect(secondLevel.parentElement?.style.paddingLeft).toBe("2.25rem");
  expect(page().getByRole("button", { name: "+ 三级标题" })).toBeTruthy();

  await user.click(page().getByRole("button", { name: "+ 三级标题" }));
  const thirdLevel = page().getByDisplayValue("三级标题");
  expect(thirdLevel.className).toContain("text-lg");
  expect(thirdLevel.parentElement?.style.paddingLeft).toBe("4rem");
  await user.click(page().getByRole("button", { name: "+ 正文" }));
  expect(page().getByPlaceholderText("正文内容")).toBeTruthy();

  await user.click(page().getByRole("button", { name: "添加显示页" }));
  expect(page().getByRole("button", { name: "新页面" })).toBeTruthy();

  await user.click(page().getByRole("button", { name: "添加标题" }));
  await user.click(page().getByRole("menuitem", { name: "+ 五级标题" }));
  const fifthLevel = page().getByDisplayValue("五级标题");
  expect(fifthLevel.className).toContain("text-sm");
  expect(fifthLevel.parentElement?.style.paddingLeft).toBe("0.5rem");

  await user.dblClick(page().getByRole("button", { name: "新页面" }));
  const pageNameInput = page().getByRole("textbox", { name: "显示页: 新页面" });
  await user.click(pageNameInput);
  await user.keyboard("{End}{Backspace}{Backspace}{Backspace}");
  await user.type(pageNameInput, "Research");
  await user.keyboard("{Enter}");
  expect(page().getByRole("button", { name: "Research" })).toBeTruthy();

  await user.click(page().getByRole("button", { name: "添加显示页" }));
  expect(page().getByRole("button", { name: "新页面" })).toBeTruthy();
  expect(page().getByRole("button", { name: "删除: 新页面" })).toBeTruthy();

  fireEvent.dragStart(page().getByRole("button", { name: "Research" }).parentElement!, {
    dataTransfer: { effectAllowed: "none", setData: () => {} },
  });
  fireEvent.drop(page().getByRole("button", { name: "Summary" }).parentElement!, {
    dataTransfer: { getData: () => "Research" },
  });
  const pageButtons = within(page().getByRole("navigation", { name: "显示页" }))
    .getAllByRole("button")
    .map((button) => button.textContent || button.getAttribute("aria-label"))
    .filter((name) => name && !name.startsWith("删除:") && name !== "添加显示页");
  expect(pageButtons).toEqual(["Research", "Summary", "新页面"]);

  fireEvent.click(page().getByRole("button", { name: "删除: 新页面" }));
  expect(page().queryByRole("button", { name: "新页面" })).toBeNull();
});
