/**
 * Shared TipTap extension factory for the weekly-report section editor.
 * Mentions, issue/channel/run refs, and skill slash menus are omitted.
 */
import type { RefObject } from "react";
import StarterKit from "@tiptap/starter-kit";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import Placeholder from "@tiptap/extension-placeholder";
import { sharedLowlight } from "../lowlight";
import Link from "@tiptap/extension-link";
import Typography from "@tiptap/extension-typography";
import Image from "@tiptap/extension-image";
import TableRow from "@tiptap/extension-table-row";
import TableHeader from "@tiptap/extension-table-header";
import TableCell from "@tiptap/extension-table-cell";
import { StableTableView } from "../stable-table-view";
import { TABLE_CELL_DEFAULT_WIDTH, TableWithColwidthMarkdown } from "../table-markdown";
import { PatchedListItem, PatchedTaskItem, PatchedTaskList } from "./list-item";
import { Markdown } from "@tiptap/markdown";
import { ReactNodeViewRenderer } from "@tiptap/react";
import type { AnyExtension } from "@tiptap/core";
import type { UploadResult } from "../types";
import { escapeMarkdownLabel } from "../utils/escape-markdown-label";
import { SlashCommandExtension } from "./slash-command-extension";
import { createBlockCommandSuggestion } from "./slash-command-suggestion";
import { CodeBlockView } from "./code-block-view";
import {
  normalizeMermaidView,
  parseCodeFenceInfo,
  serializeCodeFenceInfo,
} from "./code-block-fence";
import { createMarkdownPasteExtension } from "./markdown-paste";
import { createMarkdownCopyExtension } from "./markdown-copy";
import { createBlurShortcutExtension } from "./blur-shortcut";
import { createFileUploadExtension } from "./file-upload";
import { FileCardExtension } from "./file-card";
import { ImageView } from "./image-view";
import { BlockMathExtension, InlineMathExtension } from "./math";
import { HighlightExtension } from "./highlight";
import { TextStyleExtension } from "./text-style";

const TABLE_CELL_MIN_WIDTH = 43;

const TableCellWithDefaultWidth = TableCell.extend({
  addAttributes() {
    const parent = this.parent?.() as Record<string, Record<string, unknown>>;
    return {
      ...parent,
      colwidth: {
        ...parent.colwidth,
        default: [TABLE_CELL_DEFAULT_WIDTH],
      },
    };
  },
});

const TableHeaderWithDefaultWidth = TableHeader.extend({
  addAttributes() {
    const parent = this.parent?.() as Record<string, Record<string, unknown>>;
    return {
      ...parent,
      colwidth: {
        ...parent.colwidth,
        default: [TABLE_CELL_DEFAULT_WIDTH],
      },
    };
  },
});

const LinkExtension = Link.extend({ inclusive: false }).configure({
  openOnClick: false,
  autolink: false,
  linkOnPaste: false,
  defaultProtocol: "https",
});

export const ImageExtension = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      uploading: {
        default: false,
        renderHTML: (attrs: Record<string, unknown>) =>
          attrs.uploading ? { "data-uploading": "" } : {},
        parseHTML: (el: HTMLElement) => el.hasAttribute("data-uploading"),
      },
      width: {
        default: null,
        renderHTML: (attrs: Record<string, unknown>) =>
          attrs.width ? { width: attrs.width as number } : {},
        parseHTML: (el: HTMLElement) => {
          const w = parseInt(el.getAttribute("width") || "", 10);
          return Number.isFinite(w) ? w : null;
        },
      },
      height: {
        default: null,
        renderHTML: (attrs: Record<string, unknown>) =>
          attrs.height ? { height: attrs.height as number } : {},
        parseHTML: (el: HTMLElement) => {
          const h = parseInt(el.getAttribute("height") || "", 10);
          return Number.isFinite(h) ? h : null;
        },
      },
    };
  },
  addNodeView() {
    return ReactNodeViewRenderer(ImageView);
  },
  renderMarkdown: (node) => {
    const src = (node.attrs?.src as string) || "";
    const alt = escapeMarkdownLabel((node.attrs?.alt as string) || "");
    const title = node.attrs?.title as string | undefined;
    if (title) {
      return `![${alt}](${src} "${title}")`;
    }
    return `![${alt}](${src})`;
  },
}).configure({
  inline: false,
  allowBase64: true,
});

export interface EditorExtensionsOptions {
  placeholder?: string;
  onUploadFileRef?: RefObject<((file: File) => Promise<UploadResult | null>) | undefined>;
  mediaModeRef?: RefObject<"inline" | "external">;
  onExternalFilesRef?: RefObject<((files: File[]) => void) | undefined>;
  enableSlashCommands?: boolean;
  slashCommandMode?: "block";
  enableTextStyles?: boolean;
}

export function createEditorExtensions(options: EditorExtensionsOptions): AnyExtension[] {
  const { placeholder: placeholderText } = options;
  const onUploadFileRef = options.onUploadFileRef ?? { current: undefined };

  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      link: false,
      codeBlock: false,
      listItem: false,
    }),
    PatchedListItem,
    PatchedTaskList,
    PatchedTaskItem,
    CodeBlockLowlight.extend({
      addAttributes() {
        return {
          ...this.parent?.(),
          mermaidView: {
            default: "both",
            rendered: false,
          },
        };
      },
      parseMarkdown: (token, helpers) => {
        if (
          token.raw?.startsWith("```") === false &&
          token.raw?.startsWith("~~~") === false &&
          token.codeBlockStyle !== "indented"
        ) {
          return [];
        }
        const { language, mermaidView } = parseCodeFenceInfo(token.lang);
        return helpers.createNode(
          "codeBlock",
          {
            language: language || null,
            mermaidView,
          },
          token.text ? [helpers.createTextNode(token.text)] : [],
        );
      },
      renderMarkdown: (node, helpers) => {
        const language = (node.attrs?.language as string) || "";
        const mermaidView = normalizeMermaidView(node.attrs?.mermaidView);
        const fence = serializeCodeFenceInfo(language, mermaidView);
        if (!node.content) {
          return `\`\`\`${fence}\n\n\`\`\``;
        }
        return [`\`\`\`${fence}`, helpers.renderChildren(node.content), "```"].join("\n");
      },
      addNodeView() {
        return ReactNodeViewRenderer(CodeBlockView, {
          stopEvent: ({ event }) => {
            const target = event.target as HTMLElement | null;
            if (!target) return false;
            return Boolean(
              target.closest("[data-testid='code-block-toolbar']") ||
              target.closest("[data-slot='dropdown-menu-content']"),
            );
          },
        });
      },
    }).configure({ lowlight: sharedLowlight }),
    LinkExtension,
    ImageExtension,
    TableWithColwidthMarkdown.configure({
      resizable: true,
      renderWrapper: true,
      allowTableNodeSelection: true,
      cellMinWidth: TABLE_CELL_MIN_WIDTH,
      View: StableTableView,
    }),
    TableRow,
    TableHeaderWithDefaultWidth,
    TableCellWithDefaultWidth,
    BlockMathExtension,
    InlineMathExtension,
    HighlightExtension,
    ...(options.enableTextStyles ? [TextStyleExtension] : []),
    Markdown.configure({ indentation: { style: "space", size: 3 } }),
    createMarkdownCopyExtension(),
    FileCardExtension,
    SlashCommandExtension.configure({
      HTMLAttributes: { class: "slash-command" },
      suggestion: !options.enableSlashCommands
        ? { char: "/", allow: () => false }
        : createBlockCommandSuggestion(),
    }),
    Typography,
    Placeholder.configure({ placeholder: placeholderText }),
    createMarkdownPasteExtension(),
    createBlurShortcutExtension(),
    createFileUploadExtension(onUploadFileRef, {
      mediaModeRef: options.mediaModeRef,
      onExternalFilesRef: options.onExternalFilesRef,
    }),
  ];
}
