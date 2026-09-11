/**
 * Lightweight i18n stub — Multica's useT is replaced with English defaults.
 * Call sites that used `t(($) => $.path.to.key)` keep working via a Proxy.
 */

type Translator = (selector: (dict: any) => unknown) => string;

const LABELS: Record<string, string> = {
  "bubble_menu.bold": "Bold",
  "bubble_menu.italic": "Italic",
  "bubble_menu.strikethrough": "Strikethrough",
  "bubble_menu.code": "Code",
  "bubble_menu.highlight": "Highlight",
  "bubble_menu.link": "Link",
  "bubble_menu.quote": "Quote",
  "code_block.copy": "Copy",
  "code_block.copied": "Copied",
  "code_block.download": "Download",
  "code_block.language": "Language",
  "code_block.view_source": "Source",
  "code_block.view_preview": "Preview",
  "code_block.view_both": "Split",
  "code_block.expand": "Expand",
  "code_block.fullscreen": "Fullscreen",
  "code_block.mermaid_view": "Diagram view",
  "code_block.mermaid_source": "Source",
  "code_block.mermaid_diagram": "Diagram",
  "code_block.mermaid_both": "Split",
  "code_block.download_diagram": "Download diagram",
  "code_block.show_source": "Show source",
  "code_block.show_preview": "Show preview",
  "code_block.copy_code": "Copy code",
  "code_block.menu": "Code block menu",
  "code_block.delete": "Delete",
  "code_block.select_block": "Select block",
  "table_controls.select_table": "Select table",
  "table_controls.delete_table": "Delete table",
  "table_controls.add_column": "Add column",
  "table_controls.add_row": "Add row",
  "table_controls.column_menu": "Column menu",
  "table_controls.row_menu": "Row menu",
  "table_controls.insert_column_left": "Insert column left",
  "table_controls.insert_column_right": "Insert column right",
  "table_controls.delete_column": "Delete column",
  "table_controls.insert_row_above": "Insert row above",
  "table_controls.insert_row_below": "Insert row below",
  "table_controls.delete_row": "Delete row",
  "mermaid.expand": "Expand diagram",
  "mermaid.close": "Close",
  "mermaid.render_error": "Could not render diagram",
  "mermaid.rendering": "Rendering…",
  "slash_command.no_results": "No matching commands",
  "slash_command.commands.code": "Code block",
  "slash_command.commands.table": "Table",
  "slash_command.commands.formula": "Formula",
};

function pathFromSelector(selector: (dict: any) => unknown): string {
  const parts: string[] = [];
  const makeProxy = (): any =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (typeof prop === "string") parts.push(prop);
          return makeProxy();
        },
      },
    );
  try {
    const value = selector(makeProxy());
    if (typeof value === "string" && value.length > 0 && !parts.length) {
      return value;
    }
  } catch {
    // Proxy path collection.
  }
  return parts.join(".");
}

export function useT(_ns?: string): { t: Translator } {
  const t: Translator = (selector) => {
    const path = pathFromSelector(selector);
    return LABELS[path] ?? path.split(".").pop() ?? path;
  };
  return { t };
}
