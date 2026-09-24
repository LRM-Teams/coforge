import type { ReactNode } from "react";

import { cn } from "#src/lib/utils";

/**
 * Centered reading/editing column
 * (`mx-auto max-w-4xl px-8 py-6` ≈ 896px).
 */
export function RecordsReadingColumn({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mx-auto flex w-full min-h-full max-w-4xl flex-col px-8 py-6", className)}>
      {children}
    </div>
  );
}
