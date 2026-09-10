import { MobileNavigationButton } from "@/components/layout/sidebar/mobile-header";

/** The 48px header band every page owns. On mobile it carries the drawer button. */
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
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-secondary px-4 sm:px-6">
      {leading ?? <MobileNavigationButton />}
      <h1 className="truncate text-lg font-semibold text-primary">{heading}</h1>
      {meta}
      {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
