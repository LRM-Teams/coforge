/**
 * The header band a page owns, matching the one the conversation panels carry.
 *
 * Sits at the top of the page's card, which supplies the offset that keeps
 * every title on one line with the sidebar logo.
 */
export function PageHeader({
  leading,
  heading,
  meta,
  actions,
}: {
  /** A control that belongs before the title, such as a panel's way back. */
  leading?: React.ReactNode;
  heading: string;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4 sm:px-6">
      {leading}
      <h1 className="truncate text-base font-medium">{heading}</h1>
      {meta}
      {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
