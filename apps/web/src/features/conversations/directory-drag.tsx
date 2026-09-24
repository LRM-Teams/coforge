import { useRef, useState, type ReactNode } from "react";
import {
  MeasuringStrategy,
  MouseSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable } from "@dnd-kit/sortable";

import { cx } from "#src/utils/cx";
import type { DirectorySectionId } from "./directory-sections";
import {
  canDropInto,
  moveInDirectory,
  pinsAfterDrag,
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
  /** Saves the new pin list and reports its own failure; never rejects. Until it settles the
   * dropped layout stays on screen, then the server's list (`layout`) takes over again. */
  commit: (change: PinChange) => Promise<void>;
}) {
  const [dragging, setDragging] = useState<DirectoryLayout | null>(null);
  const [saving, setSaving] = useState<DirectoryLayout | null>(null);
  const start = useRef<DirectoryLayout | null>(null);
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 6 } }));
  const layout = dragging ?? saving ?? base;

  /** Where the dragged row goes for what it is over, or `null` to leave the layout as it is. */
  const target = (current: DirectoryLayout, { active, over }: DragOverEvent) => {
    const data = over?.data.current as DragData | undefined;
    if (!over || !data || over.id === active.id) return null;
    const inSection = current[data.section].includes(String(active.id));
    // Over a list's own space (between rows, or an empty list), it joins at the end.
    if (data.type === "section")
      return inSection ? null : { section: data.section, index: current[data.section].length };
    const siblings = current[data.section].filter((key) => key !== active.id);
    const overIndex = siblings.indexOf(String(over.id));
    const dragged = active.rect.current.translated;
    const below = dragged
      ? dragged.top + dragged.height / 2 > over.rect.top + over.rect.height / 2
      : false;
    return { section: data.section, index: overIndex + (below ? 1 : 0) };
  };

  const moved = (current: DirectoryLayout, event: DragOverEvent) => {
    const to = target(current, event);
    return to
      ? moveInDirectory(current, natural, String(event.active.id), to.section, to.index)
      : current;
  };

  const onDragOver = (event: DragOverEvent) => {
    const current = dragging ?? base;
    const next = moved(current, event);
    if (next !== current) setDragging(next);
  };

  const onDragEnd = (event: DragEndEvent) => {
    const before = start.current ?? base;
    // Released over nothing that takes the row, the drag changes nothing.
    const dropped = event.over ? moved(dragging ?? base, event) : before;
    start.current = null;
    setDragging(null);
    const change = pinsAfterDrag(before, dropped);
    if (!change) return;
    setSaving(dropped);
    void commit(change).finally(() => setSaving(null));
  };

  const context = {
    sensors,
    // Rows move between sections mid-drag, so the drop targets are measured throughout.
    measuring: { droppable: { strategy: MeasuringStrategy.Always } },
    collisionDetection: rowsFirst,
    accessibility: { announcements: SILENT_ANNOUNCEMENTS },
    // A drag that starts while the previous drop is still saving starts from that drop.
    onDragStart: () => {
      start.current = saving ?? base;
      setDragging(saving ?? base);
    },
    onDragOver,
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
  const within = pointerWithin(args).filter((hit) => {
    const data = hit.data?.droppableContainer.data.current as DragData | undefined;
    return data !== undefined && canDropInto(String(args.active.id), data.section);
  });
  const rows = within.filter(
    (hit) => (hit.data?.droppableContainer.data.current as DragData | undefined)?.type === "row",
  );
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
