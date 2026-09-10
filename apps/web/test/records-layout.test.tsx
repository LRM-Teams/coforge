import "./dom-setup";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { useState } from "react";
import { RouterContextProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AppToastProvider } from "@/components/ui/toast";
import {
  RecordsLayout,
  type RecordsCatalog,
  type RecordsTab,
} from "@/features/records/records-layout";
import { overwriteGetLocale } from "@/paraglide/runtime";
import { getRouter } from "@/router";

beforeEach(() => {
  overwriteGetLocale(() => "zh-CN");
});

afterEach(cleanup);

function page() {
  return within(document.body);
}

const emptyCatalog: RecordsCatalog = {
  actorUserId: "user-1",
  actorDisplayName: "Tester",
  favorites: [],
  highlights: [],
  myReports: [],
  memberWeeks: [],
  notes: [],
};

const sampleCatalog: RecordsCatalog = {
  ...emptyCatalog,
  favorites: [
    {
      id: "fav-1",
      title: "张亚红 2026 W36 工作周报",
      author: { userId: "u2", username: "zhang", displayName: "张亚红" },
    },
  ],
  highlights: [
    {
      id: "hl-1",
      cycleId: "c1",
      week: 35,
      title: "2026 W35 周报要点",
      completedAt: null,
    },
  ],
  myReports: [
    {
      id: "mine-1",
      title: "Tester 2026 W36 工作周报",
      status: "draft",
      year: 2026,
      week: 36,
    },
  ],
  memberWeeks: [
    {
      id: "c1",
      year: 2026,
      week: 35,
      title: "2026 W35 工作周报",
      latestTemplate: true,
      highlight: { id: "hl-1", title: "2026 W35 周报要点", completedAt: null },
      templateReport: { id: "tpl-1", title: "2026 W35 周报模板", status: "draft" },
      reports: [
        {
          id: "r1",
          title: "姜海鹏 2026 W35 工作周报",
          status: "draft",
          author: { userId: "u3", username: "jiang", displayName: "姜海鹏" },
        },
      ],
    },
  ],
};

function RecordsHarness({
  catalog = emptyCatalog,
  selectedRecordId,
}: {
  catalog?: RecordsCatalog;
  selectedRecordId?: string;
}) {
  const [tab, setTab] = useState<RecordsTab>("weekly");
  return (
    <RecordsLayout
      catalog={catalog}
      selectedRecordId={selectedRecordId}
      tab={tab}
      onTabChange={setTab}
    >
      <div>detail</div>
    </RecordsLayout>
  );
}

function renderRecords(catalog?: RecordsCatalog, selectedRecordId?: string) {
  return render(
    <RouterContextProvider router={getRouter()}>
      <AppToastProvider>
        <RecordsHarness catalog={catalog} selectedRecordId={selectedRecordId} />
      </AppToastProvider>
    </RouterContextProvider>,
  );
}

test("renders empty weekly sections without hardcoded demo people", () => {
  renderRecords();

  expect(page().getByRole("heading", { name: "记录" })).toBeTruthy();
  expect(page().getByPlaceholderText("搜索...")).toBeTruthy();
  expect(page().getByRole("radio", { name: "周报" }).getAttribute("aria-checked")).toBe("true");
  expect(page().getByText("已收藏的周报")).toBeTruthy();
  expect(page().getByText("周报要点")).toBeTruthy();
  expect(page().getByText("我的周报")).toBeTruthy();
  expect(page().getByText("成员周报")).toBeTruthy();
  expect(page().queryByText("张亚红 2026 W36 工作周报")).toBeNull();
  expect(page().getAllByText("暂无内容，可通过上方操作添加。").length).toBeGreaterThan(0);
});

test("renders catalog rows from props", () => {
  renderRecords(sampleCatalog, "hl-1");

  expect(page().getByText("张亚红 2026 W36 工作周报")).toBeTruthy();
  expect(page().getByText("2026 W35 周报要点")).toBeTruthy();
  expect(page().getByText("最新模板")).toBeTruthy();
  const selected = page().getByRole("link", { name: /2026 W35 周报要点/ });
  expect(selected.getAttribute("aria-current")).toBe("page");
});

test("switches to the notes tab", () => {
  renderRecords();

  fireEvent.click(page().getByRole("radio", { name: "笔记" }));
  expect(page().getByRole("radio", { name: "笔记" }).getAttribute("aria-checked")).toBe("true");
  expect(page().getByText("还没有笔记。")).toBeTruthy();
});

test("filters the weekly list by search query", async () => {
  const user = userEvent.setup({ document });
  renderRecords(sampleCatalog);

  await user.type(page().getByPlaceholderText("搜索..."), "姜海鹏");
  expect(page().getByText("姜海鹏 2026 W35 工作周报")).toBeTruthy();
  expect(page().queryByText("张亚红 2026 W36 工作周报")).toBeNull();
});

test("exposes stats and settings from the toolbar", () => {
  renderRecords();

  expect(page().getByRole("radio", { name: "周报统计" })).toBeTruthy();
  expect(page().getByRole("radio", { name: "周报设置" })).toBeTruthy();
});
