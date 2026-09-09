import { cn } from "@/lib/utils";

/** Decorative only: the owning region provides a single loading announcement. */
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn("block rounded-md bg-border/60", className)} />;
}
