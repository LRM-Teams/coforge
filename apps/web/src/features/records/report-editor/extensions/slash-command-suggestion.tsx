"use client";

/**
 * Slash command suggestion — block commands only (/code /table /formula).
 * Skill and Multica built-in chat commands are omitted.
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { SuggestionOptions } from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import { Code2, Sigma, Table2 } from "lucide-react";
import { isImeComposing } from "../lib/ime";
import { getLastInsertedCodeBlockLanguage } from "../code-block-language";
import { createSuggestionPopupRender } from "./suggestion-popup";

export type BuiltinCommandKey = "code" | "table" | "formula";
type SlashCommandIcon = "code" | "table" | "formula";

export interface SlashCommandItem {
  id: string;
  label: string;
  description?: string;
  descriptionKey?: BuiltinCommandKey;
  icon?: SlashCommandIcon;
}

interface SlashCommandListProps {
  items: SlashCommandItem[];
  query: string;
  command: (item: SlashCommandItem) => void;
  hideOnEmpty?: boolean;
}

export interface SlashCommandListRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

function slashCommandIcon(item: SlashCommandItem) {
  if (item.icon === "code")
    return <Code2 className="mt-0.5 size-4 text-muted-foreground" aria-hidden />;
  if (item.icon === "table")
    return <Table2 className="mt-0.5 size-4 text-muted-foreground" aria-hidden />;
  if (item.icon === "formula")
    return <Sigma className="mt-0.5 size-4 text-muted-foreground" aria-hidden />;
  return null;
}

export const SlashCommandList = forwardRef<SlashCommandListRef, SlashCommandListProps>(
  function SlashCommandList({ items, query, command, hideOnEmpty = false }, ref) {
    const [selectedIndex, setSelectedIndex] = useState(0);
    const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

    useEffect(() => {
      setSelectedIndex(0);
    }, [items]);

    useEffect(() => {
      itemRefs.current[selectedIndex]?.scrollIntoView({ block: "nearest" });
    }, [selectedIndex]);

    const selectItem = useCallback(
      (index: number) => {
        const item = items[index];
        if (!item) return;
        command(item);
      },
      [items, command],
    );

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }) => {
        if (isImeComposing(event)) return false;
        if (event.key === "ArrowUp") {
          if (items.length === 0) return false;
          setSelectedIndex((i) => (i + items.length - 1) % items.length);
          return true;
        }
        if (event.key === "ArrowDown") {
          if (items.length === 0) return false;
          setSelectedIndex((i) => (i + 1) % items.length);
          return true;
        }
        if (event.key === "Enter") {
          if (items.length === 0) return false;
          selectItem(selectedIndex);
          return true;
        }
        return false;
      },
    }));

    if (items.length === 0) {
      if (hideOnEmpty) return null;
      return (
        <div className="rounded-md border bg-popover p-2 text-xs text-muted-foreground shadow-md">
          {query.trim() ? "No matching commands" : "No commands"}
        </div>
      );
    }

    return (
      <div className="max-h-[300px] w-72 overflow-y-auto rounded-md border bg-popover py-1 shadow-md">
        {items.map((item, index) => (
          <button
            key={item.id}
            ref={(el) => {
              itemRefs.current[index] = el;
            }}
            type="button"
            className={`flex w-full items-start gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
              selectedIndex === index ? "bg-accent" : "hover:bg-accent/50"
            }`}
            onClick={() => selectItem(index)}
          >
            {slashCommandIcon(item)}
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="font-medium">{item.label}</span>
            </span>
          </button>
        ))}
      </div>
    );
  },
);

export const BLOCK_COMMANDS: SlashCommandItem[] = [
  { id: "code", label: "code", descriptionKey: "code", icon: "code" },
  { id: "table", label: "table", descriptionKey: "table", icon: "table" },
  { id: "formula", label: "formula", descriptionKey: "formula", icon: "formula" },
];

export function buildBlockCommandItems(query: string): SlashCommandItem[] {
  const q = query.toLowerCase();
  return BLOCK_COMMANDS.filter((command) => command.label.startsWith(q));
}

export function createBlockCommandSuggestion(): Omit<
  SuggestionOptions<SlashCommandItem>,
  "editor"
> {
  const pluginKey = new PluginKey("blockCommandSuggestion");

  return {
    char: "/",
    pluginKey,
    items: ({ query }) => buildBlockCommandItems(query),
    command: ({ editor, range, props }) => {
      const chain = editor.chain().focus().deleteRange(range);
      if (props.id === "table") {
        chain.insertTable({ rows: 3, cols: 3, withHeaderRow: false }).run();
        return;
      }
      if (props.id === "formula") {
        chain.setBlockMath("").run();
        return;
      }
      const language = getLastInsertedCodeBlockLanguage();
      chain.setCodeBlock({ language }).run();
    },
    render: createSuggestionPopupRender<
      SlashCommandItem,
      SlashCommandItem,
      SlashCommandListRef,
      SlashCommandListProps
    >({
      pluginKey,
      component: SlashCommandList,
      getProps: (props) => ({
        items: props.items,
        query: props.query,
        command: props.command,
        hideOnEmpty: true,
      }),
      onKeyDown: (ref, props) => ref?.onKeyDown(props) ?? false,
    }),
  };
}
