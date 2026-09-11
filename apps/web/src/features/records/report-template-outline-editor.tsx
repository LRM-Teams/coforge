import { useMemo, useState } from "react";
import { Plus, XClose as X } from "@untitledui/icons";

import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { m } from "@/paraglide/messages";

const MAX_LEVEL = 3;
type HeadingLevel = 1 | 2 | 3;
type OutlineNode =
  | { id: number; kind: "heading"; level: HeadingLevel; text: string }
  | { id: number; kind: "body"; text: string };

function parseOutline(markdown: string): OutlineNode[] {
  if (!markdown) return [];
  return markdown.split("\n").map((line, id) => {
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (!heading) return { id, kind: "body", text: line };
    return {
      id,
      kind: "heading",
      level: Math.min(heading[1]!.length, MAX_LEVEL) as HeadingLevel,
      text: heading[2]!.trim(),
    };
  });
}

function serializeOutline(nodes: OutlineNode[]) {
  return nodes
    .map((node) => (node.kind === "body" ? node.text : `${"#".repeat(node.level)} ${node.text}`))
    .join("\n");
}

function defaultHeading(level: HeadingLevel) {
  if (level === 1) return m.records_template_heading_level_one();
  if (level === 2) return m.records_template_heading_level_two();
  return m.records_template_heading_level_three();
}

function addLabel(level: HeadingLevel) {
  if (level === 1) return m.records_template_add_heading_level_one();
  if (level === 2) return m.records_template_add_heading_level_two();
  return m.records_template_add_heading_level_three();
}

function headingClass(level: HeadingLevel) {
  if (level === 1) return "text-2xl font-semibold leading-tight";
  if (level === 2) return "text-xl font-semibold leading-tight";
  return "text-lg font-semibold leading-tight";
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
    const node = nodes[index]!;
    if (node.kind === "body") {
      updateNodes(nodes.filter((current) => current.id !== id));
      return;
    }
    let end = index + 1;
    while (end < nodes.length) {
      const candidate = nodes[end];
      if (!candidate || candidate.kind !== "heading" || candidate.level <= node.level) break;
      end += 1;
    }
    updateNodes(nodes.filter((_, nodeIndex) => nodeIndex < index || nodeIndex >= end));
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-8 sm:py-6">
      <div className="flex w-full flex-col gap-1">
        <div className="flex flex-wrap items-center gap-1 pb-2">
          {([1, 2, 3] as const).map((level) => (
            <Button
              key={level}
              type="button"
              size="sm"
              color="link-gray"
              iconLeading={Plus}
              onPress={() => addHeading(level)}
              className="w-fit px-1 text-brand-secondary"
            >
              {addLabel(level)}
            </Button>
          ))}
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

        {nodes.map((node) => {
          if (node.kind === "body") {
            return (
              <div
                key={node.id}
                className="group flex min-h-9 w-full items-center gap-1 rounded-md bg-secondary px-2"
              >
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
              </div>
            );
          }

          const childLevel = Math.min(node.level + 1, MAX_LEVEL) as HeadingLevel;
          const canAddChild = node.level < MAX_LEVEL;
          return (
            <div
              key={node.id}
              className="group flex min-h-11 w-full items-center gap-1 rounded-md bg-secondary px-2"
              style={{ paddingLeft: `${0.5 + (node.level - 1) * 1.75}rem` }}
            >
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
            </div>
          );
        })}
      </div>
    </div>
  );
}
