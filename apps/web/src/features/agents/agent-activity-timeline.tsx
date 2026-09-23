import {
  Fragment,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Activity as ActivityIcon, ChevronRight } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { ClockTime } from "@/components/ui/relative-time";
import { StatusDot } from "@/components/ui/status-dot";
import { calendarDayKey, formatCalendarDayLabel } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { getLocale } from "@/paraglide/runtime";
import { m } from "@/paraglide/messages";
import type { ActivityEntry } from "./agent-activity";
import { presentActivityRows, type PresentedActivityRow } from "./agent-activity-presentation";

export function AgentActivityTimeline({
  activity,
  timeZone,
  /** The Agent profile panel's narrow column: the list drops the page-level card border (the
   * panel is flat, per docs/design/page-skeleton-and-density.md §8) in favor of plain hairline rows. Same rows,
   * same clock column, same 6px coloured dot, same monospace command text — a responsive prop
   * rather than a second component (`src/features/agents/AGENTS.md`'s Activity-tab rule). */
  compact = false,
}: {
  activity: ActivityEntry[];
  timeZone: string | null;
  compact?: boolean;
}) {
  // presentActivityRows is newest-first (its own documented contract, kept for the
  // avatar/popover's top-N slice); the timeline itself reads oldest at top, newest at bottom.
  const rows = useMemo(() => [...presentActivityRows(activity)].reverse(), [activity]);

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

  const locale = getLocale();

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto">
      <ol
        aria-label="Activity timeline"
        className={cn(
          "list-none divide-y divide-secondary",
          compact ? "px-4" : "mt-6 rounded-xl border border-secondary px-4 md:px-6",
        )}
      >
        {rows.map((row, index) => {
          const previous = rows[index - 1];
          const dayChanged =
            !previous ||
            calendarDayKey(new Date(previous.observedAtMs), timeZone) !==
              calendarDayKey(new Date(row.observedAtMs), timeZone);
          return (
            <Fragment key={row.key}>
              {dayChanged && (
                <li
                  aria-hidden="true"
                  className="py-2 text-center text-xs font-medium text-tertiary"
                  style={{ contentVisibility: "auto", containIntrinsicSize: "auto 36px" }}
                >
                  {formatCalendarDayLabel(new Date(row.observedAtMs), timeZone, locale)}
                </li>
              )}
              <ActivityTimelineRow row={row} timeZone={timeZone} compact={compact} />
            </Fragment>
          );
        })}
      </ol>
    </div>
  );
}

function ActivityTimelineRow({
  row,
  timeZone,
  compact,
}: {
  row: PresentedActivityRow;
  timeZone: string | null;
  compact: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const canExpand = row.expandable && row.detail.length > 200;
  // Fixed left clock column in both variants: an absolute HH:MM:SS reads better in a
  // chronological log than "6h ago", which keeps shifting as the page stays open.
  const clock = (
    <ClockTime
      value={new Date(row.observedAtMs)}
      timeZone={timeZone}
      className="font-mono text-xs tabular-nums text-tertiary"
    />
  );
  const label = canExpand ? (
    <Button
      color="link-gray"
      size="sm"
      className="font-semibold text-primary hover:text-primary"
      aria-expanded={expanded}
      aria-controls={contentId}
      onPress={() => setExpanded(!expanded)}
      iconLeading={
        <ChevronRight aria-hidden="true" className={cn("size-3.5", expanded && "rotate-90")} />
      }
    >
      {row.label}
    </Button>
  ) : (
    <span className={cn("font-semibold", row.tone === "error" && "text-error-primary")}>
      {row.label}
    </span>
  );
  // Tool rows (monospace, non-expandable): a single line, the summary inline after the label.
  const toolDetail = !row.expandable && row.monospace && row.detail && (
    <span
      className={cn(
        "min-w-0 break-all font-mono text-xs text-tertiary",
        row.tone === "error" && "text-error-primary",
      )}
    >
      {row.detail}
    </span>
  );
  // Every other non-expandable row's secondary text (status detail, error text): plain,
  // wrapping prose.
  const plainDetail = !row.expandable && !row.monospace && row.detail && (
    <span
      className={cn(
        "min-w-0 text-tertiary whitespace-pre-wrap break-words select-text",
        row.tone === "error" && "text-error-primary",
      )}
    >
      {row.detail}
    </span>
  );
  const expandableDetail = row.expandable && row.detail && (
    <p
      id={contentId}
      className={cn(
        "mt-1 font-mono text-xs leading-5 whitespace-pre-wrap break-words text-tertiary select-text",
        canExpand && !expanded && "line-clamp-2",
      )}
    >
      {row.detail}
    </p>
  );

  // Up to 500 frames load per Agent: content-visibility keeps off-screen rows'
  // layout/paint cheap, the same trick the file browser uses for its own long lists.
  const renderCost: CSSProperties = {
    contentVisibility: "auto",
    containIntrinsicSize: compact ? "auto 56px" : "auto 72px",
  };

  if (compact)
    return (
      <li className="grid grid-cols-[3.5rem_1fr] items-start gap-2 py-3" style={renderCost}>
        {clock}
        <div className="flex min-w-0 items-start gap-2">
          <StatusDot tone={row.tone} pulse={row.pulse} className="mt-1.5 size-1.5" />
          <div className="min-w-0 flex-1 text-sm">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              {label}
              {toolDetail}
              {plainDetail}
            </div>
            {expandableDetail}
          </div>
        </div>
      </li>
    );
  return (
    <li
      className="grid gap-2 py-4 md:grid-cols-[7rem_minmax(0,1fr)] md:items-start md:gap-5"
      style={renderCost}
    >
      {clock}
      <div className="flex min-w-0 items-start gap-2">
        <StatusDot tone={row.tone} pulse={row.pulse} className="mt-2 size-1.5" />
        <div className="min-w-0 flex-1 text-sm">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            {label}
            {row.subagent && (
              <span className="rounded border border-secondary px-1 text-xs text-tertiary">
                Subagent
              </span>
            )}
            {toolDetail}
            {plainDetail}
          </div>
          {expandableDetail}
        </div>
      </div>
    </li>
  );
}
