import type { ReactNode } from "react";

import { cx } from "#src/utils/cx";

/**
 * A header row with underline tabs: identity on the left, the tabs centered, utility actions on the
 * right. The row follows its own width, not the viewport's (a thread or profile pane can squeeze
 * a conversation on a wide screen): when it is narrower than `@2xl`, the tabs drop to a second row
 * under the identity. The tabs sit on the header's bottom rule (`-mb-px`), which lets the active
 * tab's underline stand in for the rule beneath it. `className` sets the side gutter.
 */
export function TabbedHeader({
  identity,
  actions,
  tabs,
  className,
}: {
  identity: ReactNode;
  actions?: ReactNode;
  tabs?: ReactNode;
  className?: string;
}) {
  return (
    <div className="@container/tabbed-header shrink-0">
      <header
        className={cx(
          "grid grid-cols-[minmax(0,1fr)_auto] border-b border-secondary px-4 md:px-6 @2xl/tabbed-header:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] @2xl/tabbed-header:gap-x-6",
          className,
        )}
      >
        {/* The row plus this header's 1px rule is the 48px band, so it lines up with the page
            header beside it. */}
        <div className="col-start-1 row-start-1 flex h-[calc(--spacing(12)-1px)] min-w-0 items-center gap-2 md:gap-3">
          {identity}
        </div>
        {actions && (
          <div className="col-start-2 row-start-1 flex items-center justify-self-end @2xl/tabbed-header:col-start-3">
            {actions}
          </div>
        )}
        {tabs && (
          <div className="col-span-2 row-start-2 -mb-px flex items-end @2xl/tabbed-header:col-span-1 @2xl/tabbed-header:col-start-2 @2xl/tabbed-header:row-start-1">
            {tabs}
          </div>
        )}
      </header>
    </div>
  );
}
