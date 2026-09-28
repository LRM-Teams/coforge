import type { TaskHistoryEvent, TaskStatus } from "@lrm/coforge-sdk/internal";

export type TaskTimelineEntry = {
  event: TaskHistoryEvent;
  /** The status this event set, which colours its node; undefined draws a hollow node. */
  status?: TaskStatus;
  /** The status in effect down to the next node; undefined on the last node or before any status. */
  lineStatus?: TaskStatus;
};

/** Pairs each history event with the status colours its timeline node and connecting line use. */
export function taskTimeline(events: readonly TaskHistoryEvent[]): TaskTimelineEntry[] {
  let current: TaskStatus | undefined;
  return events.map((event, index) => {
    const status =
      event.eventType === "created"
        ? event.payload.status
        : event.eventType === "status_changed"
          ? event.payload.to
          : undefined;
    current = status ?? current;
    return { event, status, lineStatus: index < events.length - 1 ? current : undefined };
  });
}
