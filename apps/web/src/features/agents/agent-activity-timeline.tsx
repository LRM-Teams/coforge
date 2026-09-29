import { memo, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { replaceEqualDeep } from "@tanstack/react-query";
import { Activity as ActivityIcon, ChevronRight } from "@untitledui/icons";
import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#src/components/ui/empty";
import { ClockTime } from "#src/components/ui/relative-time";
import { StatusDot } from "#src/components/ui/status-dot";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type { ActivityEntry } from "./agent-activity";
import { presentActivityRows, type PresentedActivityRow } from "./agent-activity-presentation";

/** The profile panel's Activity log: one dense line per row, oldest at the top, newest at the
 * bottom, the list kept scrolled to the newest row. */
export function AgentActivityTimeline({
  activity,
  timeZone,
}: {
  activity: ActivityEntry[];
  timeZone: string | null;
}) {
  // Each live frame re-presents the whole feed into fresh objects. Handing an unchanged row its
  // previous object back lets `memo` skip it, so a frame re-renders only the rows it added or
  // grew.
  const previous = useRef<Map<string, PresentedActivityRow>>(undefined);
  const rows = useMemo(() => {
    const reusable = previous.current ?? new Map<string, PresentedActivityRow>();
    const next = new Map<string, PresentedActivityRow>();
    // presentActivityRows is newest-first; the log reads oldest at top, newest at bottom.
    const timeline = presentActivityRows(activity)
      .reverse()
      .map((presented) => {
        const earlier = reusable.get(presented.key);
        const row = earlier ? replaceEqualDeep(earlier, presented) : presented;
        next.set(row.key, row);
        return row;
      });
    previous.current = next;
    return timeline;
  }, [activity]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const newest = rows.at(-1);
  // Re-runs whenever a row is appended or the newest row grows (a streamed statement merging
  // in another fragment) — the two ways the list can change without an explicit "load more".
  const newestSignal = newest ? `${newest.key}:${newest.detail.length}` : "";
  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [newestSignal]);

  if (!rows.length)
    return (
      <Empty className="h-full items-center justify-center px-6 text-center">
        <EmptyHeader className="items-center gap-3">
          <EmptyMedia>
            <ActivityIcon aria-hidden="true" className="size-6 text-tertiary" />
          </EmptyMedia>
          <EmptyTitle role="heading" aria-level={2}>
            {m.agent_activity_empty()}
          </EmptyTitle>
          <EmptyDescription>{m.agent_activity_empty_description()}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto">
      <ol aria-label="Activity timeline" className="list-none py-2">
        {rows.map((row) => (
          <ActivityTimelineRow key={row.key} row={row} timeZone={timeZone} />
        ))}
      </ol>
    </div>
  );
}

// Up to 500 frames load per Agent: content-visibility keeps off-screen rows' layout/paint cheap,
// the same trick the file browser uses for its own long lists.
const ROW_RENDER_COST: CSSProperties = {
  contentVisibility: "auto",
  containIntrinsicSize: "auto 2rem",
};

const ActivityTimelineRow = memo(function ActivityTimelineRow({
  row,
  timeZone,
}: {
  row: PresentedActivityRow;
  timeZone: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const canExpand = row.expandable && row.detail.length > 200;
  const errorText = row.tone === "error" && "text-error-primary";
  const label = canExpand ? (
    <Button
      color="link-gray"
      size="sm"
      className="font-medium text-primary hover:text-primary"
      aria-expanded={expanded}
      aria-controls={contentId}
      onPress={() => setExpanded(!expanded)}
      iconTrailing={
        <ChevronRight aria-hidden="true" className={cn("size-3", expanded && "rotate-90")} />
      }
    >
      {row.label}
    </Button>
  ) : (
    <span className={cn("font-medium text-primary", errorText)}>{row.label}</span>
  );
  return (
    <li
      className="flex items-start gap-2 px-5 py-1.5 hover:bg-primary_hover"
      style={ROW_RENDER_COST}
    >
      {/* An absolute HH:MM:SS reads better in a chronological log than "6h ago", which keeps
          shifting as the page stays open; the column takes the clock's own width, so a 12-hour
          clock's "AM" never runs into the row. */}
      <ClockTime
        value={new Date(row.observedAtMs)}
        timeZone={timeZone}
        className="mt-0.5 shrink-0 font-mono text-xs whitespace-nowrap text-quaternary tabular-nums"
      />
      <StatusDot tone={row.tone} pulse={row.pulse} className="mt-1.5 size-1.5 shrink-0" />
      <div className="min-w-0 flex-1 text-sm">
        <div className="flex flex-wrap items-baseline gap-x-1.5">
          {label}
          {row.subagent && (
            <Badge size="sm" color="gray" className="shrink-0 self-center">
              Subagent
            </Badge>
          )}
          {/* Tool rows: the argument summary inline after the label, in monospace. Other
              non-expandable rows: the status detail or error text as plain prose. */}
          {!row.expandable && row.detail && (
            <span
              className={cn(
                "min-w-0 text-tertiary select-text",
                row.monospace ? "font-mono text-xs break-all" : "break-words whitespace-pre-wrap",
                errorText,
              )}
            >
              {row.detail}
            </span>
          )}
        </div>
        {row.expandable && row.detail && (
          <p
            id={contentId}
            className={cn(
              "mt-0.5 font-mono text-xs leading-5 break-words whitespace-pre-wrap text-tertiary select-text",
              canExpand && !expanded && "line-clamp-2",
            )}
          >
            {row.detail}
          </p>
        )}
      </div>
    </li>
  );
});
