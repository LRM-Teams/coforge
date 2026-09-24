import { useRef, useState, type ReactNode } from "react";
import {
  MouseSensor,
  closestCenter,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";

import { cx } from "#src/utils/cx";
import type { DirectorySectionId } from "./directory-sections";
import { moveInDirectory, pinsAfterDrag, type DirectoryLayout } from "./pinned-conversations";

type PinRefs = NonNullable<ReturnType<typeof pinsAfterDrag>>;
type DragData =
  | { type: "row"; section: DirectorySectionId }
  | { type: "section"; section: DirectorySectionId };

/**
 * Drag-to-pin for the Chat sidebar ([dnd-kit Sortable](https://docs.dndkit.com/presets/sortable),
 * multiple containers). A row dragged into Pinned is pinned where it is dropped, Pinned rows
 * reorder among themselves, and a Pinned row dragged back to its own section is unpinned; the
 * rules live in `moveInDirectory`. The row moves between sections live while it is dragged, and the
 * dropped layout stays on screen until the server's list comes back.
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
  natural: Record<"channels" | "agents", readonly string[]>;
  /** Saves the new pin list; rejects when it could not be saved, and the layout snaps back. */
  commit: (pins: PinRefs) => Promise<void>;
}) {
  const [dragging, setDragging] = useState<DirectoryLayout | null>(null);
  const [saving, setSaving] = useState<DirectoryLayout | null>(null);
  const start = useRef<DirectoryLayout | null>(null);
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 6 } }));
  const layout = dragging ?? saving ?? base;

  const target = ({ active, over }: DragOverEvent) => {
    const data = over?.data.current as DragData | undefined;
    if (!over || !data) return null;
    const current = dragging ?? base;
    if (data.type === "section")
      return { section: data.section, index: current[data.section].length };
    // Within one list, the drop takes the hovered row's place, as the list's sorting animation shows.
    if (current[data.section].includes(String(active.id)))
      return { section: data.section, index: current[data.section].indexOf(String(over.id)) };
    // Coming from another list, it goes above or below the hovered row by which half it is over.
    const siblings = current[data.section].filter((key) => key !== active.id);
    const overIndex = siblings.indexOf(String(over.id));
    const dragged = active.rect.current.translated;
    const below = dragged
      ? dragged.top + dragged.height / 2 > over.rect.top + over.rect.height / 2
      : false;
    return { section: data.section, index: overIndex + (below ? 1 : 0) };
  };

  const onDragOver = (event: DragOverEvent) => {
    const to = target(event);
    if (!to) return;
    const current = dragging ?? base;
    const from = (event.active.data.current as DragData | undefined)?.section;
    // Reordering inside one section is the sortable list's own animation until the drop.
    if (from === to.section && current[to.section].includes(String(event.active.id))) return;
    const next = moveInDirectory(current, natural, String(event.active.id), to.section, to.index);
    if (next !== current) setDragging(next);
  };

  const onDragEnd = (event: DragEndEvent) => {
    const before = start.current ?? base;
    const current = dragging ?? base;
    const to = target(event);
    const dropped = to
      ? moveInDirectory(current, natural, String(event.active.id), to.section, to.index)
      : before;
    start.current = null;
    setDragging(null);
    const pins = pinsAfterDrag(before, dropped);
    if (!pins) return;
    setSaving(dropped);
    void commit(pins).finally(() => setSaving(null));
  };

  const context = {
    sensors,
    collisionDetection: rowsFirst,
    accessibility: { announcements: SILENT_ANNOUNCEMENTS },
    onDragStart: () => {
      start.current = base;
      setDragging(base);
    },
    onDragOver,
    onDragEnd,
    onDragCancel: () => {
      start.current = null;
      setDragging(null);
    },
  };
  return { layout, dragActive: dragging !== null, context };
}

/** The drop target under the pointer, a row before its section; the nearest row otherwise. */
const rowsFirst: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  const rows = within.filter(
    (hit) => (hit.data?.droppableContainer.data.current as DragData | undefined)?.type === "row",
  );
  if (rows.length > 0) return rows;
  if (within.length > 0) return within;
  return closestCenter(args);
};

/** Rows are dragged with a pointer only, so there is nothing to announce. */
const SILENT_ANNOUNCEMENTS = {
  onDragStart: () => undefined,
  onDragOver: () => undefined,
  onDragEnd: () => undefined,
  onDragCancel: () => undefined,
};

/**
 * One section's list as a drop target. Pinned sorts its rows as another row is dragged over them;
 * Channels and Direct messages keep their rows still, because they are not ordered by hand.
 */
export function DirectoryDropList({
  section,
  keys,
  label,
  className,
  children,
}: {
  section: DirectorySectionId;
  keys: readonly string[];
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `section:${section}`,
    data: { type: "section", section } satisfies DragData,
  });
  return (
    <SortableContext
      id={section}
      items={[...keys]}
      strategy={section === "pinned" ? verticalListSortingStrategy : keepStill}
    >
      <ul
        ref={setNodeRef}
        aria-label={label}
        className={cx("flex flex-col rounded-md", isOver && "bg-primary_hover", className)}
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
        if (!dragged.current) return;
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
