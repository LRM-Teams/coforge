import type { ReactNode } from "react";

/**
 * The conversation header's one row: identity on the left, the Chat / Tasks / Files tabs centered,
 * utility actions on the right. Below `md` the pane is too narrow for all three on one line, so
 * the tabs drop to a second row under the identity. The tabs sit on the header's bottom rule
 * (`-mb-px`), which lets the active tab's underline stand in for the rule beneath it.
 */
export function ConversationHeader({
  identity,
  actions,
  tabs,
}: {
  identity: ReactNode;
  actions?: ReactNode;
  tabs?: ReactNode;
}) {
  return (
    <header className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] border-b border-secondary px-4 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:gap-x-6 md:px-6">
      <div className="col-start-1 row-start-1 flex h-12 min-w-0 items-center gap-2 md:gap-3">
        {identity}
      </div>
      {actions && (
        <div className="col-start-2 row-start-1 flex items-center justify-self-end md:col-start-3">
          {actions}
        </div>
      )}
      {tabs && (
        <div className="col-span-2 row-start-2 -mb-px flex items-end md:col-span-1 md:col-start-2 md:row-start-1">
          {tabs}
        </div>
      )}
    </header>
  );
}
