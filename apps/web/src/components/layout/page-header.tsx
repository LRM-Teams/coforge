import { MobileNavigationButton } from "#src/components/layout/sidebar/mobile-header";

/**
 * The 48px header band every page owns. On mobile it carries the drawer button.
 *
 * With `tabs` it takes the conversation header's layout: title on the left, the tabs centered,
 * actions on the right. When the page is narrower than `@2xl`, the tabs drop to a second row under
 * the title. The tabs sit on the header's bottom rule (`-mb-px`), so the active tab's underline
 * stands in for the rule beneath it.
 */
export function PageHeader({
  leading,
  heading,
  meta,
  actions,
  tabs,
}: {
  /** A control that belongs before the title, such as a panel's way back. */
  leading?: React.ReactNode;
  heading: string;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  /** Underline tabs that switch the page's view. */
  tabs?: React.ReactNode;
}) {
  const title = (
    <>
      {leading ?? <MobileNavigationButton />}
      <h1 className="truncate text-lg font-semibold text-primary">{heading}</h1>
      {meta}
    </>
  );
  if (tabs)
    return (
      <div className="@container/page-header shrink-0">
        <header className="grid grid-cols-[minmax(0,1fr)_auto] border-b border-secondary px-4 sm:px-6 @2xl/page-header:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] @2xl/page-header:gap-x-6">
          <div className="col-start-1 row-start-1 flex h-12 min-w-0 items-center gap-3">
            {title}
          </div>
          {actions && (
            <div className="col-start-2 row-start-1 flex items-center gap-2 justify-self-end @2xl/page-header:col-start-3">
              {actions}
            </div>
          )}
          <div className="col-span-2 row-start-2 -mb-px flex items-end @2xl/page-header:col-span-1 @2xl/page-header:col-start-2 @2xl/page-header:row-start-1">
            {tabs}
          </div>
        </header>
      </div>
    );
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-secondary px-4 sm:px-6">
      {title}
      {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
