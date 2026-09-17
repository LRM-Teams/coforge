import { useId, useState } from "react";
import { Activity as ActivityIcon, ChevronRight } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { RelativeTime } from "@/components/ui/relative-time";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";
import type { ActivityEntry } from "./agent-activity";
import {
  activityToneClass,
  presentActivityRows,
  type ActivityRow,
} from "./agent-activity-presentation";

export function AgentActivityTimeline({
  activity,
  timeZone,
  /** The Agent profile panel's narrow column: time moves onto the label row (right-aligned)
   * instead of its own left column, and the list drops the page-level card border (the panel is
   * flat, per docs/ui-guidelines.md §3) in favor of plain hairline rows. Same rows, same 6px
   * coloured dot, same monospace command block — a responsive prop rather than a second component
   * (`apps/web/AGENTS.md`'s Activity-tab guidance). */
  compact = false,
}: {
  activity: ActivityEntry[];
  timeZone: string | null;
  compact?: boolean;
}) {
  const rows = presentActivityRows(activity);
  if (!rows.length)
    return compact ? (
      <div className="px-6 py-10 text-center">
        <p className="font-medium">{m.agent_activity_empty()}</p>
        <p className="mt-1 text-sm leading-6 text-tertiary">
          {m.agent_activity_empty_description()}
        </p>
      </div>
    ) : (
      <div className="my-8 flex flex-col items-center rounded-xl border border-secondary px-6 py-12 text-center">
        <span className="mb-4 rounded-xl border border-secondary p-3 shadow-xs">
          <ActivityIcon aria-hidden="true" className="size-6 text-tertiary" />
        </span>
        <p className="font-medium">{m.agent_activity_empty()}</p>
        <p className="mt-1 max-w-md text-sm leading-6 text-tertiary">
          {m.agent_activity_empty_description()}
        </p>
      </div>
    );
  return (
    <ol
      aria-label="Activity timeline"
      className={cn(
        "list-none divide-y divide-secondary",
        compact ? "px-4" : "mt-6 rounded-xl border border-secondary px-4 md:px-6",
      )}
    >
      {rows.map((row) => (
        <ActivityTimelineRow
          key={row.key}
          row={row}
          observedAtMs={row.observedAtMs}
          timeZone={timeZone}
          compact={compact}
        />
      ))}
    </ol>
  );
}

function ActivityTimelineRow({
  row,
  observedAtMs,
  timeZone,
  compact,
}: {
  row: ActivityRow;
  observedAtMs: number;
  timeZone: string | null;
  compact: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const canExpand = row.expandable && row.detail.length > 200;
  const time = (
    <RelativeTime
      value={new Date(observedAtMs)}
      timeZone={timeZone}
      className="whitespace-nowrap text-xs tabular-nums text-tertiary sm:pt-0.5"
    />
  );
  if (compact)
    return (
      <li className="py-3">
        <div className="flex min-w-0 items-start gap-2">
          <span
            aria-hidden="true"
            className={cn(
              "mt-1.5 size-1.5 shrink-0 rounded-full",
              activityToneClass(row.tone),
              row.pulse && "motion-safe:animate-pulse",
            )}
          />
          <div className="min-w-0 flex-1 text-sm">
            <div className="flex items-baseline gap-2">
              <span className={cn("font-semibold", row.tone === "error" && "text-error-primary")}>
                {row.label}
              </span>
              <span className="ml-auto shrink-0">{time}</span>
            </div>
            {!row.expandable && row.detail && !row.monospace && (
              <span
                className={cn(
                  "block text-sm text-tertiary",
                  row.tone === "error" && "text-error-primary",
                )}
              >
                {row.detail}
              </span>
            )}
            {!row.expandable && row.detail && row.monospace && (
              <p
                className={cn(
                  "mt-1.5 rounded-lg bg-secondary px-3 py-2 font-mono text-xs leading-5 whitespace-pre-wrap break-words text-secondary",
                  row.tone === "error" && "text-error-primary",
                )}
              >
                {row.detail}
              </p>
            )}
            {row.expandable && row.detail && (
              <p className="mt-1 line-clamp-3 text-sm leading-5 text-tertiary">{row.detail}</p>
            )}
          </div>
        </div>
      </li>
    );
  return (
    <li className="grid gap-2 py-4 md:grid-cols-[7rem_minmax(0,1fr)] md:items-start md:gap-5">
      {time}
      <div className="flex min-w-0 items-start gap-2">
        <span
          aria-hidden="true"
          className={cn(
            "mt-2 size-1.5 shrink-0 rounded-full",
            activityToneClass(row.tone),
            row.pulse && "motion-safe:animate-pulse",
          )}
        />
        <div className="min-w-0 flex-1 text-sm">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {canExpand ? (
              <Button
                color="link-gray"
                size="sm"
                className="font-semibold text-primary hover:text-primary"
                aria-expanded={expanded}
                aria-controls={contentId}
                onPress={() => setExpanded(!expanded)}
                iconLeading={
                  <ChevronRight
                    aria-hidden="true"
                    className={cn("size-3.5", expanded && "rotate-90")}
                  />
                }
              >
                {row.label}
              </Button>
            ) : (
              <span className={cn("font-semibold", row.tone === "error" && "text-error-primary")}>
                {row.label}
              </span>
            )}
            {row.subagent && (
              <span className="rounded border border-secondary px-1 text-xs text-tertiary">
                Subagent
              </span>
            )}
            {!row.expandable && row.detail && !row.monospace && (
              <span
                className={cn(
                  "select-text whitespace-pre-wrap break-words text-tertiary",
                  row.tone === "error" && "text-error-primary",
                )}
              >
                {row.detail}
              </span>
            )}
          </div>
          {!row.expandable && row.detail && row.monospace && (
            <p
              className={cn(
                "mt-1.5 select-text rounded-lg bg-secondary px-3 py-2 font-mono text-xs leading-5 whitespace-pre-wrap break-words text-secondary",
                row.tone === "error" && "text-error-primary",
              )}
            >
              {row.detail}
            </p>
          )}
          {row.expandable && (
            <p
              id={contentId}
              className={cn(
                "mt-1 select-text whitespace-pre-wrap break-words text-xs leading-5 text-tertiary",
                canExpand && !expanded && "line-clamp-2",
              )}
            >
              {row.detail}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}
