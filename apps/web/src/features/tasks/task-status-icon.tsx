import type { TaskStatus } from "@lrm/coforge-sdk/internal";

import { cn } from "#src/lib/utils";

/**
 * A status as a small ring that fills as the work advances, the way Linear draws issue states:
 * To do an open ring, In progress half full, In review three-quarters, Done a filled check,
 * Closed a filled cross. Colours follow `TASK_STATUS_COLOR`, so the icon, the popup's badge and
 * the history timeline agree.
 */
const RING: Record<TaskStatus, { color: string; fill: number; mark?: string }> = {
  todo: { color: "text-utility-orange-500", fill: 0 },
  in_progress: { color: "text-utility-blue-500", fill: 0.5 },
  in_review: { color: "text-utility-indigo-500", fill: 0.75 },
  done: { color: "text-utility-green-500", fill: 1, mark: "M5.2 8.2l1.9 1.9 3.7-3.9" },
  closed: { color: "text-utility-neutral-400", fill: 1, mark: "M6 6l4 4M10 6l-4 4" },
};

// The inner pie is a circle of radius 3 stroked 6 wide: its dash length is the filled share.
const PIE = 2 * Math.PI * 3;

export function TaskStatusIcon({ status, className }: { status: TaskStatus; className?: string }) {
  const ring = RING[status];
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={cn("size-4 shrink-0", ring.color, className)}
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
