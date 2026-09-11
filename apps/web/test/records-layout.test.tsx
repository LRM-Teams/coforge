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
  memberTemplates: [],
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
  highlights: [],
  myReports: [
    {
      id: "mine-1",
      title: "Tester 2026 W36 工作周报",
      status: "draft",
      year: 2026,
      week: 36,
    },
  ],
  memberTemplates: [
    {
      id: "tpl-1",
      title: "2026 W35 工作周报",
      status: "draft",
      year: 2026,
      week: 35,
      cycleId: "c1",
      latestTemplate: true,
      submissions: [
        {
          id: "r1",
          title: "姜海鹏 2026 W35 工作周报",
          status: "submitted",
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
  expect(page().getByRole("button", { name: "周报" }).getAttribute("aria-pressed")).toBe("true");
  expect(page().getByText("已收藏的周报")).toBeTruthy();
  expect(page().queryByText("周报要点")).toBeNull();
  expect(page().getByText("我的周报")).toBeTruthy();
  expect(page().getByText("成员周报")).toBeTruthy();
  expect(page().queryByText("张亚红 2026 W36 工作周报")).toBeNull();
  expect(page().queryByText("暂无内容，可通过上方操作添加。")).toBeNull();
});

test("renders template nodes as editable leaves with submissions as children", () => {
  renderRecords(sampleCatalog, "tpl-1");

  expect(page().getByText("张亚红 2026 W36 工作周报")).toBeTruthy();
  expect(page().queryByText("2026 W35 周报要点")).toBeNull();
  expect(page().getByText("最新")).toBeTruthy();
  const template = page().getByRole("link", { name: /2026 W35 工作周报/ });
  expect(template.getAttribute("aria-current")).toBe("page");
  expect(template.getAttribute("href")).toContain("/records/tpl-1");
  expect(page().queryByText("2026 W35 周报模板")).toBeNull();
});

test("switches to the notes tab", () => {
  renderRecords();

  fireEvent.click(page().getByRole("button", { name: "笔记" }));
  expect(page().getByRole("button", { name: "笔记" }).getAttribute("aria-pressed")).toBe("true");
  expect(page().getByText("我的笔记")).toBeTruthy();
  expect(page().getByRole("button", { name: "新建笔记" })).toBeTruthy();
});

test("lists notes as links into the record detail route", () => {
  renderRecords({
    ...emptyCatalog,
    notes: [
      {
        id: "note-1",
        title: "会议纪要",
        preview: "今天讨论了…",
        authorId: "user-1",
        updatedAt: "2026-09-11T00:00:00.000Z",
      },
    ],
  });

  fireEvent.click(page().getByRole("button", { name: "笔记" }));
  const link = page().getByRole("link", { name: /会议纪要/ });
  expect(link.getAttribute("href")).toContain("/records/note-1");
});

test("filters the weekly list by search query", async () => {
  const user = userEvent.setup({ document });
  renderRecords(sampleCatalog);

  await user.type(page().getByPlaceholderText("搜索..."), "姜海鹏");
  expect(page().getByText("姜海鹏 2026 W35 工作周报")).toBeTruthy();
  expect(page().queryByText("张亚红 2026 W36 工作周报")).toBeNull();
});

test("exposes a create-child action on each member-week template row", () => {
  renderRecords(sampleCatalog);

  expect(page().getByRole("button", { name: "在此周报下新建子页面" })).toBeTruthy();
});

test("exposes independent create actions for reports", () => {
  renderRecords();

  expect(page().queryByRole("button", { name: "添加当周周报要点" })).toBeNull();
  expect(page().getByRole("button", { name: "添加我的周报" })).toBeTruthy();
  expect(page().getByRole("button", { name: "添加成员周报" })).toBeTruthy();
});

test("exposes weekly tools menu for stats and settings", async () => {
  const user = userEvent.setup({ document });
  renderRecords();

  await user.click(page().getByRole("button", { name: "周报工具" }));
  expect(page().getByRole("menuitem", { name: "周报统计" })).toBeTruthy();
  expect(page().getByRole("menuitem", { name: "周报设置" })).toBeTruthy();
});
