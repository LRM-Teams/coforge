import type { TaskStatus } from "@lrm/coforge-sdk/internal";

import { cn } from "#src/lib/utils";

/** One colour per status, shared by the status icon, the board and the task popup: the badge
 * colour, the solid dot, the icon's colour, and the lighter line the popup's history timeline
 * draws between nodes. */
export const TASK_STATUS_COLOR = {
  todo: {
    badge: "orange",
    dot: "bg-utility-orange-500",
    text: "text-utility-orange-500",
    line: "bg-utility-orange-300",
  },
  in_progress: {
    badge: "blue",
    dot: "bg-utility-blue-500",
    text: "text-utility-blue-500",
    line: "bg-utility-blue-300",
  },
  in_review: {
    badge: "indigo",
    dot: "bg-utility-indigo-500",
    text: "text-utility-indigo-500",
    line: "bg-utility-indigo-300",
  },
  done: {
    badge: "success",
    dot: "bg-utility-green-500",
    text: "text-utility-green-500",
    line: "bg-utility-green-300",
  },
  closed: {
    badge: "gray",
    dot: "bg-utility-neutral-400",
    text: "text-utility-neutral-400",
    line: "bg-utility-neutral-300",
  },
} as const satisfies Record<TaskStatus, { badge: string; dot: string; text: string; line: string }>;

/**
 * A status as a small ring that fills as the work advances, the way Linear draws issue states:
 * To do an open ring, In progress half full, In review three-quarters, Done a filled check,
 * Closed a filled cross. Colours follow `TASK_STATUS_COLOR`, so the icon, the popup's badge and
 * the history timeline agree.
 */
const RING: Record<TaskStatus, { fill: number; mark?: string }> = {
  todo: { fill: 0 },
  in_progress: { fill: 0.5 },
  in_review: { fill: 0.75 },
  done: { fill: 1, mark: "M5.2 8.2l1.9 1.9 3.7-3.9" },
  closed: { fill: 1, mark: "M6 6l4 4M10 6l-4 4" },
};

// The inner pie is a circle of radius 3 stroked 6 wide: its dash length is the filled share.
const PIE = 2 * Math.PI * 3;

export function TaskStatusIcon({ status, className }: { status: TaskStatus; className?: string }) {
  const ring = RING[status];
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={cn("size-4 shrink-0", TASK_STATUS_COLOR[status].text, className)}
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        fill={ring.mark ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.5"
      />
      {!ring.mark && ring.fill > 0 && (
        <circle
          cx="8"
          cy="8"
          r="3"
          fill="none"
          stroke="currentColor"
          strokeWidth="6"
          strokeDasharray={`${PIE * ring.fill} ${PIE}`}
          transform="rotate(-90 8 8)"
        />
      )}
      {ring.mark && (
        <path
          d={ring.mark}
          fill="none"
          stroke="white"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}
