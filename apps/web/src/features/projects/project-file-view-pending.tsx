import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";

// The file view's loading state lives apart from `project-file-view.tsx` so a caller that loads the
// view on demand (the Agent profile's Workspace tab) can show it without pulling in the viewer and
// the editor and highlighter it renders with.

const SKELETON_BAR_WIDTHS = [
  "w-11/12",
  "w-2/3",
  "w-4/5",
  "w-1/2",
  "w-3/4",
  "w-5/6",
  "w-1/3",
  "w-2/3",
  "w-4/5",
  "w-1/2",
  "w-3/5",
  "w-2/5",
];

export function ProjectFileViewSkeleton({ name }: { name: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-busy="true">
      <span className="sr-only">{m.project_tree_loading()}</span>
      <div className="flex items-center gap-2 border-b border-secondary px-4 py-2">
        <span className="min-w-0 truncate text-sm font-medium text-primary">{name}</span>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-hidden px-4 py-4">
        {SKELETON_BAR_WIDTHS.map((width, index) => (
          <div
            key={index}
            className={cn(
              "h-2.5 animate-pulse rounded bg-secondary motion-reduce:animate-none",
              width,
            )}
          />
        ))}
      </div>
    </div>
  );
}
