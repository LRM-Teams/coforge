import type { TaskView } from "@lrm/coforge-sdk/internal";

import { Avatar } from "#src/components/base/avatar/avatar";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";

/** An avatar and name, as cards show the owner and the popup shows the assignee and creator. */
export function TaskPerson({
  person,
  className,
}: {
  person: { name: string; avatarUrl?: string | null };
  className?: string;
}) {
  return (
    <span
      className={cn("flex min-w-0 items-center gap-2 text-sm font-medium text-primary", className)}
    >
      <Avatar
        size="xs"
        initials={person.name.trim().charAt(0).toUpperCase()}
        alt=""
        src={person.avatarUrl ?? undefined}
      />
      <span className="truncate">{person.name}</span>
    </span>
  );
}

export function TaskOwner({ owner }: { owner: TaskView["owner"] }) {
  return (
    <span className="flex min-w-0 items-center text-xs">
      <span className="sr-only">{m.tasks_overview_owner()}: </span>
      {owner ? (
        <TaskPerson person={owner} className="text-xs font-normal text-secondary" />
      ) : (
        <span className="flex min-w-0 items-center gap-2 text-tertiary">
          <span
            aria-hidden="true"
            className="size-6 shrink-0 rounded-full border border-dashed border-primary"
          />
          <span className="truncate">{m.tasks_unassigned()}</span>
        </span>
      )}
    </span>
  );
}
