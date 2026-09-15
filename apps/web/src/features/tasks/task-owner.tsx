import type { TaskView } from "@coforge/protocol";

import { Avatar } from "@/components/base/avatar/avatar";
import { Tooltip, TooltipTrigger } from "@/components/base/tooltip/tooltip";
import { m } from "@/paraglide/messages";

export function TaskOwner({ owner, showName }: { owner: TaskView["owner"]; showName: boolean }) {
  if (!owner) {
    return (
      <span className="flex min-w-0 items-center text-xs text-tertiary">
        <span className="sr-only">{m.tasks_overview_owner()}: </span>
        {m.tasks_unassigned()}
      </span>
    );
  }
  const initials = owner.name.trim().charAt(0).toUpperCase();
  if (showName) {
    return (
      <span className="flex min-w-0 items-center gap-2 text-xs text-secondary">
        <span className="sr-only">{m.tasks_overview_owner()}: </span>
        <Avatar size="xs" initials={initials} alt="" />
        <span className="truncate">{owner.name}</span>
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-center text-xs text-secondary">
      <span className="sr-only">{m.tasks_overview_owner()}: </span>
      <Tooltip title={owner.name}>
        <TooltipTrigger className="rounded-full">
          <Avatar size="xs" initials={initials} alt="" />
          <span className="sr-only">{owner.name}</span>
        </TooltipTrigger>
      </Tooltip>
    </span>
  );
}
