import "./dom-setup";

import { expect, mock, test } from "bun:test";
import { render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CodeBlockToolbar } from "@/features/records/report-editor/extensions/code-block-view";

function renderToolbar() {
  const onLanguageChange = mock(() => {});
  const onDelete = mock(() => {});
  render(
    <CodeBlockToolbar
      language="plaintext"
      isMermaid={false}
      isHtml={false}
      htmlView="source"
      mermaidView="both"
      copied={false}
      mermaidActionsEnabled={false}
      onLanguageChange={onLanguageChange}
      onMermaidViewChange={() => {}}
      onToggleHtmlView={() => {}}
      onCopy={() => {}}
      onZoom={() => {}}
      onDownload={() => {}}
      onDelete={onDelete}
      onMenuOpenChange={() => {}}
    />,
  );
  return { onLanguageChange, onDelete };
}

test("selects a code language from the keyboard and invokes its callback", async () => {
  const { onLanguageChange } = renderToolbar();
  const user = userEvent.setup();

  await user.tab();
  expect(document.activeElement).toBe(
    within(document.body).getByRole("button", { name: "Language" }),
  );
  await user.keyboard("{Enter}");
  const python = await within(document.body).findByRole("menuitemradio", { name: "Python" });
  python.focus();
  await user.keyboard("{Enter}");

  expect(onLanguageChange).toHaveBeenCalledWith("python");
});

test("invokes delete from the overflow menu using the keyboard", async () => {
  const { onDelete } = renderToolbar();
  const user = userEvent.setup();
  const menuButton = within(document.body).getByRole("button", { name: "Code block menu" });

  menuButton.focus();
  await user.keyboard("{Enter}");
  const deleteItem = await within(document.body).findByRole("menuitem", {
    name: "Delete",
  });
  deleteItem.focus();
  await user.keyboard("{Enter}");

  expect(onDelete).toHaveBeenCalledTimes(1);
});
