import type { TaskView } from "@lrm/coforge-sdk/internal";

import { Avatar } from "#src/components/base/avatar/avatar";
import { m } from "#src/paraglide/messages";

export function TaskOwner({ owner }: { owner: TaskView["owner"] }) {
  return (
    <span className="flex min-w-0 items-center gap-2 text-xs text-secondary">
      <span className="sr-only">{m.tasks_overview_owner()}: </span>
      {owner ? (
        <Avatar
          size="xs"
          initials={owner.name.trim().charAt(0).toUpperCase()}
          alt=""
          src={owner.avatarUrl ?? undefined}
        />
      ) : (
        <span
          aria-hidden="true"
          className="size-6 shrink-0 rounded-full border border-dashed border-primary"
        />
      )}
      <span className={owner ? "truncate" : "truncate text-tertiary"}>
        {owner?.name ?? m.tasks_unassigned()}
      </span>
    </span>
  );
}
