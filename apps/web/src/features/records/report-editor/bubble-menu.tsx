"use client";

/**
 * Floating formatting toolbar for text selection (no AI / issue actions).
 * Show/hide and positioning follow Multica Notes bubble-menu behavior.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { autoUpdate, computePosition, flip, hide, offset, shift } from "@floating-ui/dom";
import { posToDOMRect } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { NodeSelection } from "@tiptap/pm/state";
import {
  Bold01 as Bold,
  Check,
  CheckSquare as ListTodo,
  ChevronDown,
  Code01 as Code,
  Heading01 as Heading1,
  Heading02 as Heading2,
  HeadingSquare as Heading3,
  Brush01 as Highlighter,
  Italic01 as Italic,
  LeftIndent01 as Quote,
  Link01 as Link2,
  LinkBroken01 as Unlink,
  List,
  Rows01 as ListOrdered,
  Strikethrough01 as Strikethrough,
  Type01 as Type,
  X,
} from "@untitledui/icons";

import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Separator } from "./ui/separator";
import { Toggle } from "./ui/toggle";

function shouldShowBubbleMenu(editor: Editor): boolean {
  if (!editor.isEditable || editor.isDestroyed) return false;
  const { selection } = editor.state;
  if (selection.empty) return false;
  const { from, to } = selection;
  if (!editor.state.doc.textBetween(from, to).trim().length) return false;
  if (selection instanceof NodeSelection) return false;
  const $from = editor.state.doc.resolve(from);
  if ($from.parent.type.name === "codeBlock") return false;
  return true;
}

function MarkButton({
  label,
  pressed,
  onAction,
  children,
}: {
  label: string;
  pressed: boolean;
  onAction: () => void;
  children: React.ReactNode;
}) {
  return (
    <Toggle
      size="sm"
      pressed={pressed}
      aria-label={label}
      // Run on mouse down (with preventDefault) so the editor keeps the
      // selection; do not rely on Toggle onPressedChange under controlled mode.
      onMouseDown={(event) => {
        event.preventDefault();
        onAction();
      }}
    >
      {children}
    </Toggle>
  );
}

function HeadingDropdown({
  editor,
  activeLevel,
  onOpenChange,
}: {
  editor: Editor;
  activeLevel: number | undefined;
  onOpenChange: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const label = activeLevel ? `H${activeLevel}` : "Text";
  const items = [
    {
      label: "Normal text",
      icon: Type,
      active: !activeLevel,
      action: () => editor.chain().focus().setParagraph().run(),
    },
    {
      label: "Heading 1",
      icon: Heading1,
      active: activeLevel === 1,
      action: () => editor.chain().focus().toggleHeading({ level: 1 }).run(),
    },
    {
      label: "Heading 2",
      icon: Heading2,
      active: activeLevel === 2,
      action: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
    },
    {
      label: "Heading 3",
      icon: Heading3,
      active: activeLevel === 3,
      action: () => editor.chain().focus().toggleHeading({ level: 3 }).run(),
    },
  ];

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      onOpenChange(next);
    },
    [onOpenChange],
  );

  return (
    <Popover modal={false} open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        className="inline-flex h-7 items-center gap-0.5 rounded-md px-1.5 text-xs font-medium hover:bg-muted"
        onMouseDown={(event) => event.preventDefault()}
      >
        {label}
        <ChevronDown className="size-3" />
      </PopoverTrigger>
      <PopoverContent side="bottom" sideOffset={8} align="start" className="w-auto min-w-32 p-1">
        {items.map((item) => (
          <button
            type="button"
            key={item.label}
            className="flex w-full cursor-default items-center gap-2 rounded-md px-1.5 py-1 text-xs outline-hidden select-none hover:bg-accent hover:text-accent-foreground"
            onMouseDown={(event) => {
              event.preventDefault();
              item.action();
              handleOpenChange(false);
            }}
          >
            <item.icon className="size-3.5" />
            {item.label}
            {item.active ? <Check className="ml-auto size-3.5" /> : null}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

export function EditorBubbleMenu({ editor }: { editor: Editor }) {
  const floatingRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [linkMode, setLinkMode] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");

  const fmt = useEditorState({
    editor,
    selector: ({ editor: ed }) => ({
      bold: ed.isActive("bold"),
      italic: ed.isActive("italic"),
      strike: ed.isActive("strike"),
      code: ed.isActive("code"),
      highlight: ed.isActive("highlight"),
      link: ed.isActive("link"),
      bulletList: ed.isActive("bulletList"),
      orderedList: ed.isActive("orderedList"),
      taskList: ed.isActive("taskList"),
      blockquote: ed.isActive("blockquote"),
      heading1: ed.isActive("heading", { level: 1 }),
      heading2: ed.isActive("heading", { level: 2 }),
      heading3: ed.isActive("heading", { level: 3 }),
    }),
  });

  const virtualRef = useMemo(
    () => ({
      getBoundingClientRect: () => {
        if (editor.isDestroyed) return new DOMRect();
        const { from, to } = editor.state.selection;
        return posToDOMRect(editor.view, from, to);
      },
      contextElement: editor.view.dom,
    }),
    [editor],
  );

  useEffect(() => {
    const onTransaction = () => {
      if (!editor.isInitialized) return;
      if (menuOpen || linkMode) return;
      setVisible(shouldShowBubbleMenu(editor));
    };
    editor.on("transaction", onTransaction);
    return () => {
      editor.off("transaction", onTransaction);
    };
  }, [editor, menuOpen, linkMode]);

  useEffect(() => {
    const onBlur = () => {
      setTimeout(() => {
        if (editor.isDestroyed) return;
        const el = floatingRef.current;
        if (el && el.contains(document.activeElement)) return;
        if (editor.view.hasFocus()) return;
        if (menuOpen || linkMode) return;
        setVisible(false);
      }, 0);
    };
    editor.on("blur", onBlur);
    return () => {
      editor.off("blur", onBlur);
    };
  }, [editor, menuOpen, linkMode]);

  useEffect(() => {
    const el = floatingRef.current;
    if (!visible || !el || !editor.isInitialized) {
      if (el) el.style.visibility = "hidden";
      return;
    }

    const updatePosition = () => {
      void computePosition(virtualRef, el, {
        strategy: "fixed",
        placement: "top",
        middleware: [offset(8), flip(), shift({ padding: 8 }), hide()],
      }).then(({ x, y, middlewareData }) => {
        if (!el.isConnected) return;
        const hidden = middlewareData.hide?.referenceHidden;
        el.style.visibility = hidden ? "hidden" : "visible";
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
      });
    };

    updatePosition();
    return autoUpdate(virtualRef, el, updatePosition);
  }, [visible, editor, virtualRef]);

  if (typeof document === "undefined") return null;

  const activeLevel = fmt.heading1 ? 1 : fmt.heading2 ? 2 : fmt.heading3 ? 3 : undefined;

  return createPortal(
    <div
      ref={floatingRef}
      className={cn(
        "fixed top-0 left-0 z-50 flex items-center gap-0.5 rounded-lg border bg-popover p-1 shadow-md",
        !visible && "pointer-events-none",
      )}
      style={{ visibility: "hidden" }}
      onMouseDown={(event) => {
        // Keep editor selection when interacting with the toolbar chrome.
        if (event.target === event.currentTarget) event.preventDefault();
      }}
    >
      {linkMode ? (
        <div className="flex items-center gap-1 px-1">
          <Input
            value={linkUrl}
            onChange={(event) => setLinkUrl(event.target.value)}
            placeholder="https://"
            aria-label="URL"
            className="h-7 w-48"
            onMouseDown={(event) => event.stopPropagation()}
          />
          <Button
            size="icon-xs"
            type="button"
            variant="ghost"
            aria-label="Apply link"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (!linkUrl.trim()) {
                editor.chain().focus().extendMarkRange("link").unsetLink().run();
              } else {
                editor
                  .chain()
                  .focus()
                  .extendMarkRange("link")
                  .setLink({ href: linkUrl.trim() })
                  .run();
              }
              setLinkMode(false);
            }}
          >
            <Check className="size-3.5" />
          </Button>
          {fmt.link ? (
            <Button
              size="icon-xs"
              type="button"
              variant="ghost"
              aria-label="Unlink"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                editor.chain().focus().extendMarkRange("link").unsetLink().run();
                setLinkMode(false);
              }}
            >
              <Unlink className="size-3.5" />
            </Button>
          ) : null}
          <Button
            size="icon-xs"
            type="button"
            variant="ghost"
            aria-label="Cancel"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setLinkMode(false);
              editor.commands.focus();
            }}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      ) : (
        <>
          <HeadingDropdown editor={editor} activeLevel={activeLevel} onOpenChange={setMenuOpen} />

          <Separator orientation="vertical" className="mx-0.5 h-5" />

          <MarkButton
            label="Bold"
            pressed={fmt.bold}
            onAction={() => editor.chain().focus().toggleBold().run()}
          >
            <Bold className="size-3.5" />
          </MarkButton>
          <MarkButton
            label="Italic"
            pressed={fmt.italic}
            onAction={() => editor.chain().focus().toggleItalic().run()}
          >
            <Italic className="size-3.5" />
          </MarkButton>
          <MarkButton
            label="Strikethrough"
            pressed={fmt.strike}
            onAction={() => editor.chain().focus().toggleStrike().run()}
          >
            <Strikethrough className="size-3.5" />
          </MarkButton>
          <MarkButton
            label="Code"
            pressed={fmt.code}
            onAction={() => editor.chain().focus().toggleCode().run()}
          >
            <Code className="size-3.5" />
          </MarkButton>
          <MarkButton
            label="Highlight"
            pressed={fmt.highlight}
            onAction={() => editor.chain().focus().toggleHighlight().run()}
          >
            <Highlighter className="size-3.5" />
          </MarkButton>

          <Separator orientation="vertical" className="mx-0.5 h-5" />

          <MarkButton
            label="Bullet list"
            pressed={fmt.bulletList}
            onAction={() => editor.chain().focus().toggleBulletList().run()}
          >
            <List className="size-3.5" />
          </MarkButton>
          <MarkButton
            label="Numbered list"
            pressed={fmt.orderedList}
            onAction={() => editor.chain().focus().toggleOrderedList().run()}
          >
            <ListOrdered className="size-3.5" />
          </MarkButton>
          <MarkButton
            label="Task list"
            pressed={fmt.taskList}
            onAction={() => editor.chain().focus().toggleTaskList().run()}
          >
            <ListTodo className="size-3.5" />
          </MarkButton>
          <MarkButton
            label="Quote"
            pressed={fmt.blockquote}
            onAction={() => editor.chain().focus().toggleBlockquote().run()}
          >
            <Quote className="size-3.5" />
          </MarkButton>

          <Separator orientation="vertical" className="mx-0.5 h-5" />

          <MarkButton
            label="Link"
            pressed={fmt.link}
            onAction={() => {
              setLinkUrl((editor.getAttributes("link").href as string) ?? "");
              setLinkMode(true);
            }}
          >
            <Link2 className="size-3.5" />
          </MarkButton>
        </>
      )}
    </div>,
    document.body,
  );
}
