import type { ReactNode } from "react";
import { ChevronRight, File02, Folder } from "@untitledui/icons";
import { Button as AriaButton } from "react-aria-components";
import { cn } from "@/lib/utils";

/**
 * Classes for the React Aria tree item (`TreeItem` / `NavigationTreeItem`) around a `FileTreeRow`.
 * `NavigationTree` marks the open file with `data-current`; a plain `Tree` adds
 * `FILE_TREE_CURRENT_ITEM_CLASS` itself.
 */
export const FILE_TREE_ITEM_CLASS =
  "group/row block cursor-pointer rounded-md outline-none data-current:bg-sidebar-accent data-focus-visible:outline-2 data-focus-visible:-outline-offset-2 data-focus-visible:outline-focus-ring data-hovered:bg-primary_hover";

/** Background of the row whose file is open. */
export const FILE_TREE_CURRENT_ITEM_CLASS = "bg-sidebar-accent";

/** Left padding of a row at a React Aria tree `level` (1-based). */
export function fileTreeIndent(level: number): number {
  return 4 + (level - 1) * 16;
}

/**
 * One file or folder row, rendered inside a React Aria `TreeItemContent` /
 * `NavigationTreeItemContent`: indent, the expand chevron (a spacer for files, so names line up),
 * icon, and name. `renderLabel` wraps the icon and name, e.g. in a link; `trailing` holds row
 * actions.
 */
export function FileTreeRow({
  level,
  name,
  isDirectory,
  isExpanded,
  isCurrent,
  renderLabel = (props) => <span {...props} />,
  trailing,
}: {
  level: number;
  name: string;
  isDirectory: boolean;
  isExpanded: boolean;
  isCurrent: boolean;
  renderLabel?: (props: { className: string; children: ReactNode }) => ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div
      className="flex min-w-0 items-center gap-1 pr-1"
      style={{ paddingLeft: fileTreeIndent(level) }}
    >
      {isDirectory ? (
        <AriaButton
          slot="chevron"
          className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-quaternary outline-focus-ring hover:text-tertiary focus-visible:outline-2"
        >
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "size-3.5 transition-transform motion-reduce:transition-none",
              isExpanded && "rotate-90",
            )}
          />
        </AriaButton>
      ) : (
        <span aria-hidden="true" className="size-6 shrink-0" />
      )}
      {renderLabel({
        className: cn(
          "flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 py-1.5 text-sm outline-none",
          isCurrent ? "font-semibold text-brand-secondary" : "text-secondary",
        ),
        children: (
          <>
            {isDirectory ? (
              <Folder aria-hidden="true" className="size-4 shrink-0 text-quaternary" />
            ) : (
              <File02 aria-hidden="true" className="size-4 shrink-0 text-quaternary" />
            )}
            <span className="truncate">{name}</span>
          </>
        ),
      })}
      {trailing}
    </div>
  );
}
