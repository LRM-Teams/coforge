import type { ReactNode } from "react";

/**
 * The conversation header's one row: identity on the left, the Chat / Tasks / Files tabs centered,
 * utility actions on the right. The row follows the pane's width, not the viewport's (a thread or
 * profile pane can squeeze the conversation on a wide screen): when the pane is narrower than
 * `@2xl`, the tabs drop to a second row under the identity. The tabs sit on the header's bottom
 * rule (`-mb-px`), which lets the active tab's underline stand in for the rule beneath it.
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
    <div className="@container/conversation-header shrink-0">
      <header className="grid grid-cols-[minmax(0,1fr)_auto] border-b border-secondary px-4 md:px-6 @2xl/conversation-header:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] @2xl/conversation-header:gap-x-6">
        <div className="col-start-1 row-start-1 flex h-12 min-w-0 items-center gap-2 md:gap-3">
          {identity}
        </div>
        {actions && (
          <div className="col-start-2 row-start-1 flex items-center justify-self-end @2xl/conversation-header:col-start-3">
            {actions}
          </div>
        )}
        {tabs && (
          <div className="col-span-2 row-start-2 -mb-px flex items-end @2xl/conversation-header:col-span-1 @2xl/conversation-header:col-start-2 @2xl/conversation-header:row-start-1">
            {tabs}
          </div>
        )}
      </header>
    </div>
  );
}
