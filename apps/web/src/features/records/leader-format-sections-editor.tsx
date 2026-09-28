import { useRef, useState } from "react";
import { Minus, Plus } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { m } from "#src/paraglide/messages";
import { cn } from "#src/lib/utils";
import {
  parseLevel2Blocks,
  serializeLevel2Blocks,
  type Level2Block,
} from "./template-outline-sections";
import { RecordsReadingColumn } from "./records-reading-column";

type BlockRow = Level2Block & { id: number };

export function LeaderFormatSectionsEditor({
  defaultValue,
  onUpdate,
  onBlur,
}: {
  defaultValue: string;
  onUpdate: (markdown: string) => void;
  onBlur?: () => void;
}) {
  const nextId = useRef(0);
  const [blocks, setBlocks] = useState<BlockRow[]>(() =>
    parseLevel2Blocks(defaultValue).map((block) => ({ ...block, id: nextId.current++ })),
  );

  function commit(next: BlockRow[]) {
    setBlocks(next);
    onUpdate(serializeLevel2Blocks(next.map(({ title, body }) => ({ title, body }))));
  }

  function addAfter(index: number) {
    const next = [...blocks];
    next.splice(index + 1, 0, {
      id: nextId.current++,
      title: m.records_template_heading_level_two(),
      body: "",
    });
    commit(next);
  }

  function removeAt(index: number) {
    commit(blocks.filter((_, blockIndex) => blockIndex !== index));
  }

  function updateAt(index: number, patch: Partial<Level2Block>) {
    commit(
      blocks.map((block, blockIndex) => (blockIndex === index ? { ...block, ...patch } : block)),
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <RecordsReadingColumn className="space-y-3">
        {blocks.length === 0 ? (
          <Button
            type="button"
            size="sm"
            color="link-gray"
            iconLeading={Plus}
            onPress={() => addAfter(-1)}
          >
            {m.records_template_add_heading_level_two()}
          </Button>
        ) : null}
        {blocks.map((block, index) => (
          <section key={block.id} className="group relative rounded-xl bg-secondary px-4 py-3">
            <div className="mb-2 flex items-center gap-2">
              <input
                aria-label={m.records_template_heading_level_two()}
                value={block.title}
                onChange={(event) => updateAt(index, { title: event.target.value })}
                onBlur={onBlur}
                className="min-w-0 flex-1 bg-transparent px-0 text-base font-semibold text-primary outline-none"
              />
              <span className="shrink-0 text-xs text-tertiary">
                {m.records_template_heading_level_two()}
              </span>
              <ButtonUtility
                size="xs"
                color="tertiary"
                icon={Plus}
                aria-label={m.records_template_add_heading_level_two()}
                onClick={() => addAfter(index)}
                className="size-6 shrink-0 p-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
              />
              <ButtonUtility
                size="xs"
                color="tertiary"
                icon={Minus}
                aria-label={`${m.records_template_delete_heading()}: ${block.title}`}
                onClick={() => removeAt(index)}
                className="size-6 shrink-0 p-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
              />
            </div>
            <textarea
              aria-label={m.records_template_body_label()}
              value={block.body}
              placeholder={m.records_format_section_body_placeholder()}
              onChange={(event) => updateAt(index, { body: event.target.value })}
              onBlur={onBlur}
              rows={3}
              className={cn(
                "w-full resize-y bg-transparent px-0 text-sm leading-6 text-primary outline-none",
                "placeholder:text-placeholder",
              )}
            />
          </section>
        ))}
      </RecordsReadingColumn>
    </div>
  );
}
