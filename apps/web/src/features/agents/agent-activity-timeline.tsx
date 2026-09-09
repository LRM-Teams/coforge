import { useId, useState } from "react";
import { Activity as ActivityIcon, ChevronRight } from "@untitledui/icons";
import { Button } from "@/components/ui/button";
import { RelativeTime } from "@/components/ui/relative-time";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";
import type { ActivityEntry } from "./agent-activity";
import {
  activityToneClass,
  presentActivity,
  type ActivityRow,
} from "./agent-activity-presentation";

export function AgentActivityTimeline({
  activity,
  timeZone,
}: {
  activity: ActivityEntry[];
  timeZone: string | null;
}) {
  const rows = activity.flatMap((entry) =>
    presentActivity(entry).map((row, index) => ({
      row,
      observedAtMs: entry.observedAtMs,
      key: `${entry.launchId}:${entry.clientSeq}:${index}`,
    })),
  );
  if (!rows.length)
    return (
      <div className="my-8 flex flex-col items-center rounded-xl border px-6 py-12 text-center">
        <span className="mb-4 rounded-xl border p-3 shadow-xs">
          <ActivityIcon aria-hidden="true" className="size-6 text-muted-foreground" />
        </span>
        <p className="font-medium">{m.agent_activity_empty()}</p>
        <p className="mt-1 max-w-md text-sm leading-6 text-muted-foreground">
          {m.agent_activity_empty_description()}
        </p>
      </div>
    );
  return (
    <ol
      aria-label="Activity timeline"
      className="mt-6 list-none divide-y rounded-xl border px-4 md:px-6"
    >
      {rows.map(({ row, observedAtMs, key }) => (
        <ActivityTimelineRow key={key} row={row} observedAtMs={observedAtMs} timeZone={timeZone} />
      ))}
    </ol>
  );
}

function ActivityTimelineRow({
  row,
  observedAtMs,
  timeZone,
}: {
  row: ActivityRow;
  observedAtMs: number;
  timeZone: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const canExpand = row.expandable && row.detail.length > 200;
  return (
    <li className="grid gap-2 py-4 md:grid-cols-[7rem_minmax(0,1fr)] md:items-start md:gap-5">
      <RelativeTime
        value={new Date(observedAtMs)}
        timeZone={timeZone}
        className="whitespace-nowrap text-xs tabular-nums text-muted-foreground sm:pt-0.5"
      />
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
                variant="ghost"
                size="sm"
                className="h-auto min-h-0 justify-start p-0 font-semibold"
                aria-expanded={expanded}
                aria-controls={contentId}
                onClick={() => setExpanded(!expanded)}
              >
                <ChevronRight
                  aria-hidden="true"
                  className={cn("size-3.5", expanded && "rotate-90")}
                />
                {row.label}
              </Button>
            ) : (
              <span
                className={cn("font-semibold", row.tone === "error" && "text-destructive-text")}
              >
                {row.label}
              </span>
            )}
            {row.subagent && (
              <span className="rounded border px-1 text-xs text-muted-foreground">Subagent</span>
            )}
            {!row.expandable && row.detail && (
              <span
                className={cn(
                  "select-text whitespace-pre-wrap break-words text-muted-foreground",
                  row.monospace && "font-mono text-xs",
                  row.tone === "error" && "text-destructive-text",
                )}
              >
                {row.detail}
              </span>
            )}
          </div>
          {row.expandable && (
            <p
              id={contentId}
              className={cn(
                "mt-1 select-text whitespace-pre-wrap break-words font-mono text-xs leading-5 text-muted-foreground",
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
