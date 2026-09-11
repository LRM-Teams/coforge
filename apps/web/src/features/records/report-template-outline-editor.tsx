import { useMemo, useState } from "react";
import { Plus, XClose as X } from "@untitledui/icons";

import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { m } from "@/paraglide/messages";

const MAX_LEVEL = 3;
type HeadingLevel = 1 | 2 | 3;
type OutlineNode = { id: number; level: HeadingLevel; text: string };

function parseOutline(markdown: string): OutlineNode[] {
  return markdown
    .split("\n")
    .map((line) => line.match(/^(#{1,3})\s+(.+)$/)?.slice(1))
    .filter((parts): parts is [string, string] => Boolean(parts))
    .map(([marks, text], id) => ({
      id,
      level: Math.min(marks.length, MAX_LEVEL) as HeadingLevel,
      text: text.trim(),
    }));
}

function serializeOutline(nodes: OutlineNode[]) {
  return nodes.map((node) => `${"#".repeat(node.level)} ${node.text}`).join("\n");
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

  function addNode(parentId?: number) {
    const parentIndex =
      parentId === undefined ? -1 : nodes.findIndex((node) => node.id === parentId);
    const parent = parentId === undefined ? undefined : nodes[parentIndex];
    const level = parent ? (Math.min(parent.level + 1, MAX_LEVEL) as HeadingLevel) : 1;
    if (parent && parent.level === MAX_LEVEL) return;

    let insertAt = nodes.length;
    if (parent) {
      insertAt = parentIndex + 1;
      while (insertAt < nodes.length && nodes[insertAt]!.level > parent.level) insertAt += 1;
    }
    const nextNode: OutlineNode = {
      id: Math.max(-1, ...nodes.map((node) => node.id)) + 1,
      level,
      text: defaultHeading(level),
    };
    const next = [...nodes];
    next.splice(insertAt, 0, nextNode);
    updateNodes(next);
  }

  function updateText(id: number, text: string) {
    updateNodes(nodes.map((node) => (node.id === id ? { ...node, text } : node)));
  }

  function removeNode(id: number) {
    const index = nodes.findIndex((node) => node.id === id);
    if (index < 0) return;
    const level = nodes[index]!.level;
    let end = index + 1;
    while (end < nodes.length && nodes[end]!.level > level) end += 1;
    updateNodes(nodes.filter((_, nodeIndex) => nodeIndex < index || nodeIndex >= end));
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-8 sm:py-6">
      <div className="mx-auto flex max-w-3xl flex-col gap-1">
        <Button
          type="button"
          size="sm"
          color="link-gray"
          iconLeading={Plus}
          onPress={() => addNode()}
          className="w-fit px-1 text-brand-secondary"
        >
          {m.records_template_add_heading_level_one()}
        </Button>

        {nodes.map((node) => {
          const childLevel = Math.min(node.level + 1, MAX_LEVEL) as HeadingLevel;
          const canAddChild = node.level < MAX_LEVEL;
          return (
            <div
              key={node.id}
              className="group flex min-h-9 items-center gap-1 rounded-md bg-secondary px-2"
              style={{ marginLeft: `${(node.level - 1) * 1.75}rem` }}
            >
              <input
                aria-label={`${m.records_template_heading_label()} ${node.level}`}
                value={node.text}
                onChange={(event) => updateText(node.id, event.target.value)}
                onBlur={onBlur}
                className="min-w-0 flex-1 bg-transparent px-0.5 text-sm text-primary outline-none placeholder:text-placeholder"
              />
              {canAddChild ? (
                <ButtonUtility
                  size="xs"
                  color="tertiary"
                  icon={Plus}
                  aria-label={addLabel(childLevel)}
                  onClick={() => addNode(node.id)}
                  className="size-6 p-1 opacity-60 hover:opacity-100"
                />
              ) : null}
              <ButtonUtility
                size="xs"
                color="tertiary"
                icon={X}
                aria-label={`${m.records_template_delete_heading()}: ${node.text}`}
                onClick={() => removeNode(node.id)}
                className="size-6 p-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
