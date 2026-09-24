import { useRef, useState, type ReactNode } from "react";
import {
  MouseSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable } from "@dnd-kit/sortable";

import { cx } from "#src/utils/cx";
import type { DirectorySectionId } from "./directory-sections";
import {
  canDropInto,
  dropTarget,
  moveInDirectory,
  pinsAfterDrag,
  sameLayout,
  type DirectoryLayout,
  type HomeSection,
} from "./pinned-conversations";

type PinChange = NonNullable<ReturnType<typeof pinsAfterDrag>>;
type DragData =
  | { type: "row"; section: DirectorySectionId }
  | { type: "section"; section: DirectorySectionId };

/**
 * Drag-to-pin for the Chat sidebar ([dnd-kit Sortable](https://docs.dndkit.com/presets/sortable),
 * multiple containers). A row dragged into Pinned is pinned where it is dropped, Pinned rows
 * reorder among themselves, and a Pinned row dragged back to its own section is unpinned; the
 * rules live in `moveInDirectory`. The lists are re-laid out while the row is dragged (it goes
 * above or below the row it is over by which half it is over), so what is on screen when the
 * mouse is released is what is saved; that layout stays until the server's list comes back.
 *
 * A mouse drag starts after 6px of movement so a click still opens the conversation. There is no
 * touch or keyboard drag: a long press on a row opens its menu, which pins and unpins too.
 */
export function useDirectoryDrag({
  layout: base,
  natural,
  commit,
}: {
  layout: DirectoryLayout;
  natural: Record<HomeSection, readonly string[]>;
  /** Applies the change to the lists at once and saves it, reporting its own failure; the returned
   * promise settles when the save does (a failed save has put the lists back by then). */
  commit: (change: PinChange) => Promise<unknown>;
}) {
  const [dragging, setDragging] = useState<DirectoryLayout | null>(null);
  const [dropped, setDropped] = useState<DirectoryLayout | null>(null);
  const start = useRef<DirectoryLayout | null>(null);
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 6 } }));
  // The lists show a drop by the next render (`commit` changes them at once); until they do, the
  // dropped layout stays on screen so no row jumps back for a frame.
  if (dropped && sameLayout(dropped, base)) setDropped(null);
  const layout = dragging ?? dropped ?? base;

  const moved = (current: DirectoryLayout, { active, over }: DragMoveEvent) => {
    const data = over?.data.current as DragData | undefined;
    if (!over || !data) return current;
    const dragged = active.rect.current.translated;
    const to = dropTarget(
      current,
      String(active.id),
      { key: String(over.id), ...data },
      dragged
        ? { dragged: dragged.top + dragged.height / 2, over: over.rect.top + over.rect.height / 2 }
        : null,
    );
    return to
      ? moveInDirectory(current, natural, String(active.id), to.section, to.index)
      : current;
  };

  // `onDragOver` fires when the row under the pointer changes and `onDragMove` on every move, so
  // crossing the middle of the same row re-lays the list out too.
  const relayout = (event: DragMoveEvent) => {
    const current = dragging ?? base;
    const next = moved(current, event);
    if (next !== current) setDragging(next);
  };

  const onDragEnd = (event: DragEndEvent) => {
    const before = start.current ?? base;
    // Released over nothing that takes the row, the drag changes nothing.
    const released = event.over ? moved(dragging ?? base, event) : before;
    start.current = null;
    setDragging(null);
    const change = pinsAfterDrag(before, released);
    if (!change) return;
    setDropped(released);
    void commit(change).finally(() =>
      setDropped((current) => (current === released ? null : current)),
    );
  };

  const context = {
    sensors,
    collisionDetection: rowsFirst,
    accessibility: { announcements: SILENT_ANNOUNCEMENTS },
    // A drag that starts before the previous drop shows in the lists starts from that drop.
    onDragStart: () => {
      start.current = dropped ?? base;
      setDragging(dropped ?? base);
    },
    onDragOver: relayout,
    onDragMove: relayout,
    onDragEnd,
    onDragCancel: () => {
      start.current = null;
      setDragging(null);
    },
  };
  return { layout, context };
}

/** The drop target under the pointer that takes the dragged row, a row before its section.
 * Released anywhere else, the drag drops nothing. */
const rowsFirst: CollisionDetection = (args) => {
  const dataOf = (hit: ReturnType<CollisionDetection>[number]) =>
    hit.data?.droppableContainer.data.current as DragData | undefined;
  const within = pointerWithin(args).filter((hit) => {
    const data = dataOf(hit);
    return data !== undefined && canDropInto(String(args.active.id), data.section);
  });
  const rows = within.filter((hit) => dataOf(hit)?.type === "row");
  return rows.length > 0 ? rows : within;
};

/** Rows are dragged with a pointer only, so there is nothing to announce. */
const SILENT_ANNOUNCEMENTS = {
  onDragStart: () => undefined,
  onDragOver: () => undefined,
  onDragEnd: () => undefined,
  onDragCancel: () => undefined,
};

/**
 * One section's list as a drop target. Its rows are drawn where the layout puts them, not shifted
 * by the sortable preset, so the list on screen is always the layout a drop would save.
 */
export function DirectoryDropList({
  section,
  keys,
  label,
  children,
}: {
  section: DirectorySectionId;
  keys: readonly string[];
  label: string;
  children: ReactNode;
}) {
  const { setNodeRef, isOver, active } = useDroppable({
    id: `section:${section}`,
    data: { type: "section", section } satisfies DragData,
  });
  return (
    <SortableContext id={section} items={[...keys]} strategy={keepStill}>
      <ul
        ref={setNodeRef}
        aria-label={label}
        className={cx(
          "flex flex-col rounded-md",
          isOver && active && canDropInto(String(active.id), section) && "bg-primary_hover",
        )}
      >
        {children}
      </ul>
    </SortableContext>
  );
}

const keepStill = () => null;

/**
 * A draggable sidebar row. The row's link handles its own presses, so the drag listens in the
 * capture phase; the click that ends a drag is swallowed so a drop never opens the conversation.
 */
export function DirectoryDragRow({
  id,
  section,
  disabled,
  children,
}: {
  id: string;
  section: DirectorySectionId;
  /** A row the member cannot pin (an unjoined channel, an Agent with no DM yet) stays put. */
  disabled: boolean;
  children: ReactNode;
}) {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({
    id,
    disabled,
    data: { type: "row", section } satisfies DragData,
  });
  const dragged = useRef(false);
  if (isDragging) dragged.current = true;
  return (
    <li
      ref={setNodeRef}
      onMouseDownCapture={(event) => {
        dragged.current = false;
        listeners?.onMouseDown?.(event);
      }}
      onClickCapture={(event) => {
        // `detail` is 0 for a click from the keyboard, which is never the end of a drag.
        if (!dragged.current || event.detail === 0) return;
        dragged.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
      data-dragging={isDragging || undefined}
      className="relative py-px select-none [-webkit-touch-callout:none] data-dragging:z-10 data-dragging:cursor-grabbing data-dragging:opacity-60"
      style={{
        // Rows only move along the list.
        transform: transform ? `translate3d(0, ${transform.y}px, 0)` : undefined,
        transition,
      }}
    >
      {children}
    </li>
  );
}
