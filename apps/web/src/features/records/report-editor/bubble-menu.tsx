"use client";

/**
 * Floating formatting toolbar for text selection (no AI / issue actions).
 * Show/hide and positioning follow Multica Notes bubble-menu behavior.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Separator } from "react-aria-components";
import { Button } from "@/components/base/buttons/button";
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
  Palette,
  Strikethrough01 as Strikethrough,
  Type01 as Type,
  X,
} from "@untitledui/icons";

import { cn } from "@/lib/utils";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { Dropdown } from "@/components/base/dropdown/dropdown";
import { Input } from "@/components/base/input/input";
import {
  NOTE_COLORS,
  NOTE_FONT_SIZES,
  cssToNoteFontSize,
  fontSizeToCss,
  hexToNoteColor,
  noteColorToHex,
  type NoteColor,
} from "./utils/text-style";

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
    <Button
      color="tertiary"
      size="sm"
      className="flex size-7 items-center justify-center rounded-md text-fg-quaternary outline-focus-ring hover:bg-primary_hover hover:text-fg-quaternary_hover focus-visible:outline-2 aria-pressed:bg-primary_hover aria-pressed:text-fg-secondary"
      aria-pressed={pressed}
      aria-label={label}
      onMouseDown={(event) => event.preventDefault()}
      onPress={onAction}
    >
      {children}
    </Button>
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
    {
      label: "Heading 4",
      active: activeLevel === 4,
      action: () => editor.chain().focus().toggleHeading({ level: 4 }).run(),
    },
    {
      label: "Heading 5",
      active: activeLevel === 5,
      action: () => editor.chain().focus().toggleHeading({ level: 5 }).run(),
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
    <Dropdown.Root isOpen={open} onOpenChange={handleOpenChange}>
      <Button
        color="tertiary"
        size="sm"
        className="inline-flex h-7 items-center gap-0.5 rounded-md px-1.5 text-xs font-medium text-secondary outline-focus-ring hover:bg-primary_hover focus-visible:outline-2"
        onMouseDown={(event) => event.preventDefault()}
      >
        {label}
        <ChevronDown className="size-3" />
      </Button>
      <Dropdown.Popover placement="bottom start" offset={8} className="w-40">
        <Dropdown.Menu
          selectionMode="single"
          selectedKeys={[activeLevel ? `Heading ${activeLevel}` : "Normal text"]}
        >
          {items.map((item) => (
            <Dropdown.Item
              key={item.label}
              id={item.label}
              label={item.label}
              icon={item.icon}
              onAction={() => {
                item.action();
                handleOpenChange(false);
              }}
            />
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}

function ColorDropdown({
  editor,
  onOpenChange,
  activeColor,
}: {
  editor: Editor;
  onOpenChange: (open: boolean) => void;
  activeColor: string | null;
}) {
  const [open, setOpen] = useState(false);
  const current = hexToNoteColor(activeColor);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      onOpenChange(next);
    },
    [onOpenChange],
  );

  const apply = (color: NoteColor) => {
    const hex = noteColorToHex(color);
    if (hex) editor.chain().focus().setTextColor(hex).run();
    else editor.chain().focus().unsetTextColor().run();
    handleOpenChange(false);
  };

  return (
    <Dropdown.Root isOpen={open} onOpenChange={handleOpenChange}>
      <Button
        color="tertiary"
        size="sm"
        className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-secondary outline-focus-ring hover:bg-primary_hover focus-visible:outline-2"
        aria-label="Text color"
        onMouseDown={(event) => event.preventDefault()}
      >
        <Palette className="size-3.5" />
        <span
          className="size-2 rounded-full border border-secondary"
          style={{ backgroundColor: noteColorToHex(current) ?? "var(--color-text-primary)" }}
        />
      </Button>
      <Dropdown.Popover placement="bottom start" offset={8} className="w-44">
        <Dropdown.Menu selectionMode="single" selectedKeys={[current]}>
          {NOTE_COLORS.map((color) => (
            <Dropdown.Item key={color} id={color} label={color} onAction={() => apply(color)} />
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}

function FontSizeDropdown({
  editor,
  onOpenChange,
  activeSize,
}: {
  editor: Editor;
  onOpenChange: (open: boolean) => void;
  activeSize: string | null;
}) {
  const [open, setOpen] = useState(false);
  const current = cssToNoteFontSize(activeSize);
  const label = current ?? "Size";

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      onOpenChange(next);
    },
    [onOpenChange],
  );

  return (
    <Dropdown.Root isOpen={open} onOpenChange={handleOpenChange}>
      <Button
        color="tertiary"
        size="sm"
        className="inline-flex h-7 items-center gap-0.5 rounded-md px-1.5 text-xs font-medium text-secondary outline-focus-ring hover:bg-primary_hover focus-visible:outline-2"
        onMouseDown={(event) => event.preventDefault()}
      >
        {label}
        <ChevronDown className="size-3" />
      </Button>
      <Dropdown.Popover placement="bottom start" offset={8} className="w-32">
        <Dropdown.Menu selectionMode="single" selectedKeys={[current ?? "Default"]}>
          <Dropdown.Item
            id="Default"
            label="Default"
            onAction={() => {
              editor.chain().focus().unsetFontSize().run();
              handleOpenChange(false);
            }}
          />
          {NOTE_FONT_SIZES.map((size) => (
            <Dropdown.Item
              key={size}
              id={size}
              label={size}
              onAction={() => {
                editor.chain().focus().setFontSize(fontSizeToCss(size)).run();
                handleOpenChange(false);
              }}
            />
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown.Root>
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
      heading4: ed.isActive("heading", { level: 4 }),
      heading5: ed.isActive("heading", { level: 5 }),
      fontSize: (ed.getAttributes("textStyle").fontSize as string | null) ?? null,
      textColor: (ed.getAttributes("textStyle").color as string | null) ?? null,
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

  const activeLevel = ([1, 2, 3, 4, 5] as const).find(
    (level) => fmt[`heading${level}` as keyof typeof fmt],
  );

  return createPortal(
    <div
      ref={floatingRef}
      className={cn(
        "fixed top-0 left-0 z-50 flex max-w-[calc(100vw-1rem)] flex-wrap items-center gap-0.5 rounded-lg bg-primary p-1 shadow-lg ring-1 ring-secondary_alt",
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
            onChange={setLinkUrl}
            placeholder="https://"
            aria-label="URL"
            size="sm"
            className="w-48"
            onMouseDown={(event) => event.stopPropagation()}
          />
          <ButtonUtility
            size="xs"
            type="button"
            tooltip="Apply link"
            icon={Check}
            onMouseDown={(event: React.MouseEvent<HTMLButtonElement>) => event.preventDefault()}
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
          />
          {fmt.link ? (
            <ButtonUtility
              size="xs"
              type="button"
              tooltip="Unlink"
              icon={Unlink}
              onMouseDown={(event: React.MouseEvent<HTMLButtonElement>) => event.preventDefault()}
              onClick={() => {
                editor.chain().focus().extendMarkRange("link").unsetLink().run();
                setLinkMode(false);
              }}
            />
          ) : null}
          <ButtonUtility
            size="xs"
            type="button"
            tooltip="Cancel"
            icon={X}
            onMouseDown={(event: React.MouseEvent<HTMLButtonElement>) => event.preventDefault()}
            onClick={() => {
              setLinkMode(false);
              editor.commands.focus();
            }}
          />
        </div>
      ) : (
        <>
          <HeadingDropdown editor={editor} activeLevel={activeLevel} onOpenChange={setMenuOpen} />
          <ColorDropdown editor={editor} activeColor={fmt.textColor} onOpenChange={setMenuOpen} />
          <FontSizeDropdown editor={editor} activeSize={fmt.fontSize} onOpenChange={setMenuOpen} />

          <Separator orientation="vertical" className="mx-0.5 h-5 w-px bg-border-secondary" />

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

          <Separator orientation="vertical" className="mx-0.5 h-5 w-px bg-border-secondary" />

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

          <Separator orientation="vertical" className="mx-0.5 h-5 w-px bg-border-secondary" />

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
