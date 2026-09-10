import "./dom-setup";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { RouterContextProvider } from "@tanstack/react-router";
import { cleanup, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AppToastProvider } from "@/components/ui/toast";
import { WeeklyReportSettings } from "@/features/records/weekly-report-settings";
import { overwriteGetLocale } from "@/paraglide/runtime";
import { getRouter } from "@/router";

beforeEach(() => {
  overwriteGetLocale(() => "zh-CN");
});

afterEach(cleanup);

function page() {
  return within(document.body);
}

test("shows empty template state without demo rows", () => {
  render(
    <RouterContextProvider router={getRouter()}>
      <AppToastProvider>
        <WeeklyReportSettings templates={[]} members={[]} />
      </AppToastProvider>
    </RouterContextProvider>,
  );

  expect(page().getByRole("heading", { name: "周报设置" })).toBeTruthy();
  expect(page().getByText(/还没有周报模板/)).toBeTruthy();
  expect(page().queryByText("LRM 组周报")).toBeNull();
});

test("lists templates from props and opens create and edit dialogs", async () => {
  const user = userEvent.setup({ document });
  const template = {
    id: "t1",
    name: "设计周报",
    frequency: "weekly" as const,
    sendTime: "15:00",
    dimensions: ["Summary"],
    mainTitles: ["Current Work"],
    allMembers: true,
    recipients: [],
  };
  render(
    <RouterContextProvider router={getRouter()}>
      <AppToastProvider>
        <WeeklyReportSettings
          templates={[template]}
          members={[
            {
              userId: "u1",
              username: "barry",
              displayName: "Barry",
              role: "member",
            },
          ]}
        />
      </AppToastProvider>
    </RouterContextProvider>,
  );

  expect(page().getByText("设计周报")).toBeTruthy();
  expect(page().getByText("全部成员")).toBeTruthy();

  await user.click(page().getByRole("button", { name: /创建模板/ }));
  expect(page().getByRole("heading", { name: "创建模板" })).toBeTruthy();
  await user.click(page().getByRole("button", { name: "取消" }));

  await user.click(page().getByRole("button", { name: /编辑/ }));
  expect(page().getByRole("heading", { name: "编辑模板" })).toBeTruthy();
  expect((page().getByPlaceholderText("请输入模板名称") as HTMLInputElement).value).toBe(
    "设计周报",
  );
});
