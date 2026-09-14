import {
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type ReactNode,
} from "react";
import { DotsGrid as GripVertical, Plus, XClose as X } from "@untitledui/icons";

import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Dropdown } from "@/components/base/dropdown/dropdown";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";
import {
  dropEdgeFromClientY,
  MAX_LEVEL,
  moveOutlineNodes,
  parseOutline,
  serializeOutline,
  subtreeRange,
  type DropEdge,
  type HeadingLevel,
  type OutlineNode,
} from "./report-template-outline";

function defaultHeading(level: HeadingLevel) {
  if (level === 1) return m.records_template_heading_level_one();
  if (level === 2) return m.records_template_heading_level_two();
  if (level === 3) return m.records_template_heading_level_three();
  if (level === 4) return m.records_template_heading_level_four();
  return m.records_template_heading_level_five();
}

function addLabel(level: HeadingLevel) {
  if (level === 1) return m.records_template_add_heading_level_one();
  if (level === 2) return m.records_template_add_heading_level_two();
  if (level === 3) return m.records_template_add_heading_level_three();
  if (level === 4) return m.records_template_add_heading_level_four();
  return m.records_template_add_heading_level_five();
}

function headingClass(level: HeadingLevel) {
  if (level === 1) return "text-2xl font-semibold leading-tight";
  if (level === 2) return "text-xl font-semibold leading-tight";
  if (level === 3) return "text-lg font-semibold leading-tight";
  if (level === 4) return "text-base font-semibold leading-tight";
  return "text-sm font-semibold leading-tight";
}

function depthAt(nodes: OutlineNode[], index: number) {
  const stack: HeadingLevel[] = [];
  for (const node of nodes.slice(0, index + 1)) {
    if (node.kind === "body") continue;
    while (stack.length > 0 && stack[stack.length - 1]! >= node.level) stack.pop();
    stack.push(node.level);
  }
  const current = nodes[index];
  if (current?.kind === "body") return stack.length;
  return Math.max(0, stack.length - 1);
}

function OutlineRow({
  body,
  dragging,
  dropEdge,
  style,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  children,
}: {
  body: boolean;
  dragging: boolean;
  dropEdge: DropEdge | null;
  style: CSSProperties;
  onDragStart: (event: DragEvent<HTMLDivElement>) => void;
  onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  children: ReactNode;
}) {
  return (
    <div
      draggable
      className={cn(
        "group relative flex w-full items-center gap-1 rounded-md bg-secondary px-2",
        body ? "min-h-9" : "min-h-11",
        dragging && "opacity-50",
      )}
      style={style}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      {dropEdge ? (
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute right-2 left-2 z-10 h-0.5 rounded-full bg-brand-solid",
            dropEdge === "before" ? "-top-px" : "-bottom-px",
          )}
        />
      ) : null}
      {children}
    </div>
  );
}

export function ReportTemplateOutlineEditor({
  defaultValue,
  onUpdate,
  onBlur,
}: {
  defaultValue: string;
  onUpdate: (markdown: string) => void;
  onBlur?: () => void;
}) {
  const initialNodes = useMemo(() => parseOutline(defaultValue), [defaultValue]);
  const [nodes, setNodes] = useState(initialNodes);
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{
    targetId: number;
    edge: DropEdge;
  } | null>(null);
  const dragHandleArmedRef = useRef(false);

  function updateNodes(next: OutlineNode[]) {
    setNodes(next);
    onUpdate(serializeOutline(next));
  }

  function nextId() {
    return Math.max(-1, ...nodes.map((node) => node.id)) + 1;
  }

  function insertNode(node: OutlineNode, insertAt: number) {
    const next = [...nodes];
    next.splice(insertAt, 0, node);
    updateNodes(next);
  }

  function addHeading(level: HeadingLevel, parentId?: number) {
    const parentIndex =
      parentId === undefined ? -1 : nodes.findIndex((node) => node.id === parentId);
    const parent = parentId === undefined ? undefined : nodes[parentIndex];
    const parentHeading = parent?.kind === "heading" ? parent : undefined;
    if (parent && (!parentHeading || parentHeading.level >= MAX_LEVEL)) return;

    let insertAt = nodes.length;
    if (parentHeading) {
      insertAt = parentIndex + 1;
      while (insertAt < nodes.length) {
        const candidate = nodes[insertAt];
        if (!candidate || candidate.kind !== "heading" || candidate.level <= parentHeading.level) {
          break;
        }
        insertAt += 1;
      }
    }
    insertNode({ id: nextId(), kind: "heading", level, text: defaultHeading(level) }, insertAt);
  }

  function addBody(afterId?: number) {
    const index =
      afterId === undefined ? nodes.length - 1 : nodes.findIndex((node) => node.id === afterId);
    insertNode({ id: nextId(), kind: "body", text: "" }, index + 1);
  }

  function updateText(id: number, text: string) {
    updateNodes(nodes.map((node) => (node.id === id ? { ...node, text } : node)));
  }

  function removeNode(id: number) {
    const index = nodes.findIndex((node) => node.id === id);
    if (index < 0) return;
    const { start, end } = subtreeRange(nodes, index);
    updateNodes(nodes.filter((_, nodeIndex) => nodeIndex < start || nodeIndex >= end));
  }

  function handleDragStart(event: DragEvent<HTMLDivElement>, id: number) {
    if (!dragHandleArmedRef.current) {
      event.preventDefault();
      return;
    }
    setDraggedId(id);
    setDropIndicator(null);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(id));
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>, id: number) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (draggedId === id) {
      if (dropIndicator) setDropIndicator(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const edge = dropEdgeFromClientY(event.clientY, rect.top, rect.height);
    if (dropIndicator?.targetId !== id || dropIndicator.edge !== edge) {
      setDropIndicator({ targetId: id, edge });
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>, targetId: number) {
    event.preventDefault();
    const raw = draggedId ?? Number(event.dataTransfer.getData("text/plain"));
    const sourceId = Number.isFinite(raw) ? raw : null;
    const rect = event.currentTarget.getBoundingClientRect();
    const edge =
      dropIndicator?.targetId === targetId
        ? dropIndicator.edge
        : dropEdgeFromClientY(event.clientY, rect.top, rect.height);
    if (sourceId !== null) updateNodes(moveOutlineNodes(nodes, sourceId, targetId, edge));
    setDraggedId(null);
    setDropIndicator(null);
    dragHandleArmedRef.current = false;
  }

  function handleDragEnd() {
    setDraggedId(null);
    setDropIndicator(null);
    dragHandleArmedRef.current = false;
  }

  function dragHandle() {
    return (
      <ButtonUtility
        size="xs"
        color="tertiary"
        icon={GripVertical}
        aria-label={m.records_template_reorder_row()}
        onPointerDown={() => {
          dragHandleArmedRef.current = true;
        }}
        onPointerUp={() => {
          dragHandleArmedRef.current = false;
        }}
        onPointerCancel={() => {
          dragHandleArmedRef.current = false;
        }}
        className="size-6 shrink-0 cursor-grab touch-none p-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 active:cursor-grabbing"
      />
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-8 sm:py-6">
      <div className="flex w-full flex-col gap-1">
        <div className="flex items-center gap-2 pb-2">
          <Dropdown.Root>
            <Button
              type="button"
              size="sm"
              color="link-gray"
              iconLeading={Plus}
              className="w-fit px-1 text-brand-secondary"
            >
              {m.records_template_add_heading()}
            </Button>
            <Dropdown.Popover placement="bottom start" className="w-44">
              <Dropdown.Menu
                onAction={(key) => {
                  const level = Number(String(key).replace("heading-", "")) as HeadingLevel;
                  addHeading(level);
                }}
              >
                {([1, 2, 3, 4, 5] as const).map((level) => (
                  <Dropdown.Item key={level} id={`heading-${level}`} label={addLabel(level)} />
                ))}
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown.Root>
          <Button
            type="button"
            size="sm"
            color="link-gray"
            iconLeading={Plus}
            onPress={() => addBody()}
            className="w-fit px-1 text-brand-secondary"
          >
            {m.records_template_add_body()}
          </Button>
        </div>

        {nodes.map((node, index) => {
          const dropEdge =
            dropIndicator?.targetId === node.id && draggedId !== node.id
              ? dropIndicator.edge
              : null;
          const rowProps = {
            dragging: draggedId === node.id,
            dropEdge,
            style: { paddingLeft: `${0.5 + depthAt(nodes, index) * 1.75}rem` } as CSSProperties,
            onDragStart: (event: DragEvent<HTMLDivElement>) => handleDragStart(event, node.id),
            onDragOver: (event: DragEvent<HTMLDivElement>) => handleDragOver(event, node.id),
            onDrop: (event: DragEvent<HTMLDivElement>) => handleDrop(event, node.id),
            onDragEnd: handleDragEnd,
          };

          if (node.kind === "body") {
            return (
              <OutlineRow key={node.id} body {...rowProps}>
                {dragHandle()}
                <input
                  aria-label={m.records_template_body_label()}
                  value={node.text}
                  placeholder={m.records_template_body_placeholder()}
                  onChange={(event) => updateText(node.id, event.target.value)}
                  onBlur={onBlur}
                  className="min-w-0 flex-1 bg-transparent px-0.5 text-sm leading-6 text-primary outline-none placeholder:text-placeholder"
                />
                <ButtonUtility
                  size="xs"
                  color="tertiary"
                  icon={X}
                  aria-label={`${m.records_template_delete_body()}: ${node.text || m.records_template_body_placeholder()}`}
                  onClick={() => removeNode(node.id)}
                  className="size-6 p-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                />
              </OutlineRow>
            );
          }

          const childLevel = Math.min(node.level + 1, MAX_LEVEL) as HeadingLevel;
          const canAddChild = node.level < MAX_LEVEL;
          return (
            <OutlineRow key={node.id} body={false} {...rowProps}>
              {dragHandle()}
              <input
                aria-label={`${m.records_template_heading_label()} ${node.level}`}
                value={node.text}
                onChange={(event) => updateText(node.id, event.target.value)}
                onBlur={onBlur}
                className={`min-w-0 flex-1 bg-transparent px-0.5 text-primary outline-none placeholder:text-placeholder ${headingClass(node.level)}`}
              />
              {canAddChild ? (
                <ButtonUtility
                  size="xs"
                  color="tertiary"
                  icon={Plus}
                  aria-label={addLabel(childLevel)}
                  onClick={() => addHeading(childLevel, node.id)}
                  className="size-6 shrink-0 p-1 opacity-60 hover:opacity-100"
                />
              ) : null}
              <ButtonUtility
                size="xs"
                color="tertiary"
                icon={X}
                aria-label={`${m.records_template_delete_heading()}: ${node.text}`}
                onClick={() => removeNode(node.id)}
                className="size-6 shrink-0 p-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              />
            </OutlineRow>
          );
        })}
      </div>
    </div>
  );
}
