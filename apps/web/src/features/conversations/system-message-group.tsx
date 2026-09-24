import type { ReactNode } from "react";
import { ChevronDown } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { DayDivider, UnreadDivider } from "./message-row";
import {
  summarizeSystemGroup,
  type SystemGroupSummary,
  type SystemMessageKind,
} from "./system-message-groups";

function partLabel(kind: SystemMessageKind, count: number): string {
  if (kind === "taskUpdate") return m.conversation_system_group_task_updates({ count });
  if (kind === "reminder") return m.conversation_system_group_reminders({ count });
  return m.conversation_system_group_messages({ count });
}

/** "There are 2 task updates", or "There are 6 system updates: 5 task updates, 1 system message". */
function summaryLabel({ total, parts }: SystemGroupSummary): string {
  const labels = parts.map((part) => partLabel(part.kind, part.count));
  if (labels.length === 1)
    return m.conversation_system_group_one_part({ count: total, part: labels[0]! });
  const joined = labels.join(m.conversation_system_group_separator());
  return parts.some((part) => part.kind === "system")
    ? m.conversation_system_group_mixed({ count: total, parts: joined })
    : m.conversation_system_group_parts({ parts: joined });
}

/**
 * A run of consecutive system messages folded into one centred summary line, collapsed by
 * default. Opening it shows the notices themselves (`children`, ordinary system rows) beneath the
 * line. The group's row carries its first message's id, so opening the conversation on that
 * message (the unread boundary starts a group, never falls inside one) and keeping the reading
 * position across a history load both find it like any other row.
 */
export function SystemMessageGroup({
  id,
  messages,
  expanded,
  onToggleExpanded,
  dayChanged,
  unreadStartsHere,
  dateLocale,
  children,
}: {
  id: string;
  messages: readonly { id: string; body: string; createdAt: Date | string }[];
  expanded: boolean;
  onToggleExpanded: () => void;
  dayChanged: boolean;
  unreadStartsHere: boolean;
  dateLocale?: string;
  /** The grouped rows, rendered only while the group is open. */
  children: ReactNode;
}) {
  const first = messages[0]!;
  const listId = `${id}:messages`;
  return (
    <li
      data-message-id={first.id}
      data-system-group={id}
      // Every notice the group folds, for the scroll anchor that restores the reading position.
      data-system-group-members={messages.map((message) => message.id).join(" ")}
      className="flex flex-col"
    >
      {unreadStartsHere && <UnreadDivider />}
      {dayChanged && <DayDivider value={first.createdAt} locale={dateLocale} />}
      {/* The summary is what the reader sees of a folded group: the scroll anchor holds it. */}
      <div data-scroll-anchor className="flex justify-center px-4 py-1 md:px-6">
        <Button
          color="link-gray"
          size="sm"
          className="max-w-full text-center text-xs font-medium whitespace-normal"
          aria-expanded={expanded}
          aria-controls={expanded ? listId : undefined}
          onPress={onToggleExpanded}
          iconTrailing={
            <ChevronDown
              aria-hidden="true"
              className={cn("size-3.5 shrink-0 transition-transform", expanded && "rotate-180")}
            />
          }
        >
          {summaryLabel(summarizeSystemGroup(messages))}
        </Button>
      </div>
      {expanded && (
        <ol id={listId} className="flex flex-col">
          {children}
        </ol>
      )}
    </li>
  );
}
