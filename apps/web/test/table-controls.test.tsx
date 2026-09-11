import "./dom-setup";

import { expect, spyOn, test } from "bun:test";
import { act, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Table } from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableHeader from "@tiptap/extension-table-header";
import TableCell from "@tiptap/extension-table-cell";
import { TableControls } from "@/features/records/report-editor/table-controls";

test.each([
  ["Column menu", "{Enter}", "Insert column right", 2, 3],
  ["Column menu", " ", "Insert column right", 2, 3],
  ["Row menu", "{Enter}", "Insert row below", 3, 2],
  ["Row menu", " ", "Insert row below", 3, 2],
] as const)(
  "%s opens from the keyboard and edits the table",
  async (label, key, action, rows, cols) => {
    const bounds = spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(20, 20, 200, 80),
    );
    const root = document.createElement("div");
    const editorElement = document.createElement("div");
    root.append(editorElement);
    document.body.append(root);
    const editor = new Editor({
      element: editorElement,
      extensions: [StarterKit, Table, TableRow, TableHeader, TableCell],
      content:
        "<table><tbody><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></tbody></table>",
    });
    editor.commands.setNodeSelection(0);
    const controls = render(<TableControls editor={editor} rootRef={{ current: root }} />);
    try {
      const user = userEvent.setup();
      act(() => controls.getAllByRole("button", { name: label })[0]!.focus());
      await user.keyboard(key);
      const item = await within(document.body).findByRole("menuitem", { name: action });
      act(() => item.focus());
      await user.keyboard("{Enter}");
      const table = editor.state.doc.firstChild;
      expect(table?.childCount).toBe(rows);
      expect(table?.firstChild?.childCount).toBe(cols);
      expect(editor.state.doc.textContent).toBe("ABCD");
    } finally {
      controls.unmount();
      editor.destroy();
      root.remove();
      bounds.mockRestore();
    }
  },
);
