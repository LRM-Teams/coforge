import type { ReactNode } from "react";

/** Shared card frame for the conversation board and the workspace task overview. */
export function TaskCardShell({
  list,
  body,
  tags,
  owner,
  actions,
  extra,
}: {
  list: boolean;
  /** Title (and optional description); a button or link owned by the caller. */
  body: ReactNode;
  tags: ReactNode;
  owner: ReactNode;
  /** Drag handle and menu. */
  actions?: ReactNode;
  /** Extra footer controls such as claim/unclaim. */
  extra?: ReactNode;
}) {
  if (list) {
    return (
      <article className="flex flex-col gap-3 rounded-lg border border-secondary bg-primary p-3 shadow-xs transition-colors hover:bg-secondary sm:flex-row sm:items-center sm:gap-4 sm:px-4">
        <div className="min-w-0 flex-1">{body}</div>
        <div className="flex min-w-0 flex-wrap items-center gap-3 sm:shrink-0 sm:gap-4">
          <div className="flex flex-wrap gap-1.5">{tags}</div>
          {owner}
          {extra && <div className="flex items-center gap-1">{extra}</div>}
          {actions && <div className="flex shrink-0 items-center">{actions}</div>}
        </div>
      </article>
    );
  }
  return (
    <article className="rounded-xl border border-secondary bg-primary p-4 shadow-xs transition-shadow hover:shadow-md">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">{body}</div>
        {actions && <div className="-mt-1 -mr-1.5 flex shrink-0 items-center">{actions}</div>}
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">{tags}</div>
      <div className="mt-3 flex items-center justify-between gap-3 border-t border-secondary pt-3">
        {owner}
        {extra && (
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-1">{extra}</div>
        )}
      </div>
    </article>
  );
}

export function TaskTag({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex max-w-full items-center rounded-md bg-secondary px-2 py-0.5 text-xs font-medium text-secondary">
      <span className="truncate">{children}</span>
    </span>
  );
}

export function TaskCardBody({
  title,
  description,
}: {
  title: ReactNode;
  description?: string | null;
}) {
  return (
    <>
      <h3 className="text-sm leading-snug font-semibold text-primary [overflow-wrap:anywhere]">
        {title}
      </h3>
      {description && (
        <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-tertiary [overflow-wrap:anywhere]">
          {description}
        </p>
      )}
    </>
  );
}
