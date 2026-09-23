import { useEffect, useRef, type ComponentProps, type FC } from "react";
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";

import { Button } from "#src/components/base/buttons/button";
import { cx } from "#src/utils/cx";

export type ReorderableTabMeta = { label: () => string; icon: FC<{ className?: string }> };

/**
 * A panel's tab strip whose tabs the viewer drags into their own order. Each tab is the official
 * `Button` (secondary = active, tertiary = inactive); dragging only translates along the strip
 * ([dnd-kit Sortable](https://docs.dndkit.com/presets/sortable)). A mouse drag starts after 6px
 * of movement so a click still selects; a touch drag starts after a 250ms press so a swipe still
 * scrolls a strip that overflows a phone
 * ([dnd-kit sensors](https://docs.dndkit.com/api-documentation/sensors)).
 */
export function ReorderableTabStrip<T extends string>({
  tabs,
  meta,
  active,
  onSelect,
  onReorder,
  className,
  ...navProps
}: {
  /** The tabs in display order. */
  tabs: readonly T[];
  meta: Record<T, ReorderableTabMeta>;
  active: T;
  onSelect: (tab: T) => void;
  onReorder: (order: T[]) => void;
} & Omit<ComponentProps<"nav">, "onSelect">) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  );
  // Releasing a dragged tab is also a press on its Button; that press is swallowed so a drop only
  // reorders. The flag is cleared when the next press starts.
  const dragged = useRef(false);
  const navRef = useRef<HTMLElement>(null);
  // On a narrow viewport the strip scrolls, so the selected tab can start out of sight.
  useEffect(() => {
    navRef.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [active]);

  const dropped = ({ active: moved, over }: DragEndEvent) => {
    const from = tabs.indexOf(moved.id as T);
    const to = over ? tabs.indexOf(over.id as T) : -1;
    if (to >= 0 && from !== to) onReorder(arrayMove([...tabs], from, to));
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      // Tabs are reordered with a pointer only, so there is no keyboard drag to announce.
      accessibility={{ announcements: SILENT_ANNOUNCEMENTS }}
      onDragStart={() => (dragged.current = true)}
      onDragEnd={dropped}
    >
      <SortableContext items={[...tabs]} strategy={horizontalListSortingStrategy}>
        <nav ref={navRef} className={cx("flex items-center gap-1", className)} {...navProps}>
          {tabs.map((tab) => (
            <SortableTab
              key={tab}
              id={tab}
              meta={meta[tab]}
              active={tab === active}
              onPressStart={() => (dragged.current = false)}
              onPress={() => {
                if (!dragged.current) onSelect(tab);
              }}
            />
          ))}
        </nav>
      </SortableContext>
    </DndContext>
  );
}

const SILENT_ANNOUNCEMENTS = {
  onDragStart: () => undefined,
  onDragOver: () => undefined,
  onDragEnd: () => undefined,
  onDragCancel: () => undefined,
};

function SortableTab({
  id,
  meta,
  active,
  onPressStart,
  onPress,
}: {
  id: string;
  meta: ReorderableTabMeta;
  active: boolean;
  onPressStart: () => void;
  onPress: () => void;
}) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      // The Button handles its own press events and stops them from bubbling, so the sensors
      // listen in the capture phase on this wrapper instead.
      onMouseDownCapture={(event) => {
        onPressStart();
        listeners?.onMouseDown?.(event);
      }}
      onTouchStartCapture={(event) => {
        onPressStart();
        listeners?.onTouchStart?.(event);
      }}
      onKeyDownCapture={onPressStart}
      data-dragging={isDragging || undefined}
      className="shrink-0 select-none [-webkit-touch-callout:none] data-dragging:z-10 data-dragging:cursor-grabbing"
      style={{
        transform: transform ? `translate3d(${transform.x}px, 0, 0)` : undefined,
        transition,
      }}
    >
      <Button
        type="button"
        color={active ? "secondary" : "tertiary"}
        size="sm"
        aria-current={active ? "page" : undefined}
        iconLeading={meta.icon}
        onPress={onPress}
      >
        {meta.label()}
      </Button>
    </div>
  );
}
