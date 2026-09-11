/**
 * TipTap Markdown content editor for weekly-report sections.
 * Mirrors Multica Notes editing: formulas, tables, images, code blocks,
 * slash commands, bubble menu, file paste/drop — without Multica product refs.
 *
 * This module is only rendered under `/records/$recordId` with `ssr: "data-only"`,
 * matching Multica Notes' client-only TipTap mount (static import, no lazy chunk).
 */

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useEditor, EditorContent } from "@tiptap/react";

import { cn } from "@/lib/utils";
import { EditorBubbleMenu } from "./bubble-menu";
import { createEditorExtensions } from "./extensions";
import { uploadAndInsertFile } from "./extensions/file-upload";
import { FileDropOverlay } from "./file-drop-overlay";
import { applyTableColwidthsFromMarkdown } from "./table-markdown";
import { TableControls } from "./table-controls";
import type { UploadResult } from "./types";
import { useFileDropZone } from "./use-file-drop-zone";
import { openLink } from "./utils/link-handler";
import {
  MARKDOWN_CHUNK_THRESHOLD,
  parseMarkdownChunked,
  type MarkdownManagerLike,
} from "./utils/parse-markdown-chunked";
import { preprocessMarkdown } from "./utils/preprocess";

import "katex/dist/katex.min.css";
import "./styles/index.css";

const BLOB_IMAGE_RE = /!\[[^\]]*\]\(blob:[^)]*\)\n?/g;

function stripBlobUrls(md: string): string {
  return md.replace(BLOB_IMAGE_RE, "");
}

export type ContentEditorProps = {
  defaultValue?: string;
  onUpdate?: (markdown: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  className?: string;
  debounceMs?: number;
  onUploadFile?: (file: File) => Promise<UploadResult | null>;
  showBubbleMenu?: boolean;
};

export type ContentEditorRef = {
  getMarkdown: () => string;
  clearContent: () => void;
  focus: () => void;
  blur: () => void;
  uploadFile: (file: File) => void;
  setMarkdown: (markdown: string) => void;
};

type MarkdownEmitEditor = {
  isDestroyed: boolean;
  view: { composing: boolean };
  getMarkdown: () => string;
};

export const ContentEditor = forwardRef<ContentEditorRef, ContentEditorProps>(
  function ContentEditor(
    {
      defaultValue = "",
      onUpdate,
      onBlur,
      placeholder: placeholderText = "",
      className,
      debounceMs = 300,
      onUploadFile,
      showBubbleMenu = true,
    },
    ref,
  ) {
    const rootRef = useRef<HTMLDivElement>(null);
    const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
    const onUpdateRef = useRef(onUpdate);
    const onBlurRef = useRef(onBlur);
    const onUploadFileRef = useRef(onUploadFile);
    const mediaModeRef = useRef<"inline" | "external">("inline");
    const lastEmittedRef = useRef<string | null>(null);
    const dirtyRef = useRef(false);
    const markdownEmitEditorRef = useRef<MarkdownEmitEditor | null>(null);

    onUpdateRef.current = onUpdate;
    onBlurRef.current = onBlur;
    onUploadFileRef.current = onUploadFile;

    const scheduleMarkdownEmit = (ed: MarkdownEmitEditor) => {
      if (!onUpdateRef.current || ed.isDestroyed) return;
      const fire = () => {
        if (ed.isDestroyed || ed.view.composing) return;
        const md = stripBlobUrls(ed.getMarkdown()).trimEnd();
        if (md === lastEmittedRef.current) return;
        lastEmittedRef.current = md;
        onUpdateRef.current?.(md);
      };
      if (debounceMs <= 0) {
        fire();
        return;
      }
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(fire, debounceMs);
    };

    const extensions = useMemo(
      () =>
        createEditorExtensions({
          placeholder: placeholderText,
          onUploadFileRef,
          mediaModeRef,
          enableSlashCommands: true,
          slashCommandMode: "block",
          enableTextStyles: true,
        }),
      [placeholderText],
    );

    const initialMarkdown = preprocessMarkdown(defaultValue);

    const editor = useEditor({
      extensions,
      content: initialMarkdown.length < MARKDOWN_CHUNK_THRESHOLD ? initialMarkdown : "",
      contentType: "markdown",
      immediatelyRender: false,
      editorProps: {
        attributes: {
          class: "rich-text-editor ProseMirror focus:outline-none",
        },
        handleClick: (_view, _pos, event) => {
          const target = event.target as HTMLElement | null;
          const anchor = target?.closest("a");
          if (!anchor) return false;
          const href = anchor.getAttribute("href");
          if (!href) return false;
          event.preventDefault();
          openLink(href);
          return true;
        },
      },
      onUpdate: ({ editor: ed }) => {
        dirtyRef.current = true;
        markdownEmitEditorRef.current = ed as unknown as MarkdownEmitEditor;
        scheduleMarkdownEmit(ed as unknown as MarkdownEmitEditor);
      },
      onBlur: () => {
        onBlurRef.current?.();
      },
    });

    useEffect(() => {
      if (!editor) return;
      if (initialMarkdown.length < MARKDOWN_CHUNK_THRESHOLD) {
        applyTableColwidthsFromMarkdown(editor, defaultValue);
        return;
      }
      let cancelled = false;
      void parseMarkdownChunked(
        editor.storage.markdown as unknown as MarkdownManagerLike,
        initialMarkdown,
      ).then((doc: unknown) => {
        if (cancelled || editor.isDestroyed) return;
        editor.commands.setContent(doc as Parameters<typeof editor.commands.setContent>[0]);
        applyTableColwidthsFromMarkdown(editor, defaultValue);
      });
      return () => {
        cancelled = true;
      };
    }, [editor]);

    useEffect(() => {
      if (!editor || editor.isDestroyed) return;
      editor.view.dom.classList.add("note-format");
      return () => {
        editor.view.dom.classList.remove("note-format");
      };
    }, [editor]);

    useEffect(() => {
      if (!editor || dirtyRef.current) return;
      const next = preprocessMarkdown(defaultValue);
      const current = stripBlobUrls(editor.getMarkdown()).trimEnd();
      if (next.trimEnd() === current) return;
      editor.commands.setContent(next, { contentType: "markdown" });
      applyTableColwidthsFromMarkdown(editor, defaultValue);
      lastEmittedRef.current = next.trimEnd();
    }, [defaultValue, editor]);

    useEffect(() => {
      return () => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
      };
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        getMarkdown: () => (editor ? stripBlobUrls(editor.getMarkdown()).trimEnd() : ""),
        clearContent: () => {
          editor?.commands.clearContent();
          lastEmittedRef.current = "";
        },
        focus: () => editor?.commands.focus(),
        blur: () => editor?.commands.blur(),
        uploadFile: (file: File) => {
          if (!editor || !onUploadFileRef.current) return;
          void uploadAndInsertFile(editor, file, onUploadFileRef.current);
        },
        setMarkdown: (markdown: string) => {
          if (!editor) return;
          const next = preprocessMarkdown(markdown);
          editor.commands.setContent(next, { contentType: "markdown" });
          applyTableColwidthsFromMarkdown(editor, markdown);
          lastEmittedRef.current = stripBlobUrls(next).trimEnd();
          dirtyRef.current = false;
        },
      }),
      [editor],
    );

    const { isDragging } = useFileDropZone({
      enabled: Boolean(onUploadFile),
      onDrop: (files) => {
        if (!editor || !onUploadFileRef.current) return;
        for (const file of files) {
          void uploadAndInsertFile(editor, file, onUploadFileRef.current);
        }
      },
    });

    if (!editor) return null;

    return (
      <div
        ref={rootRef}
        className={cn("report-editor relative", className)}
        onMouseDown={(event: ReactMouseEvent) => {
          if (event.target === event.currentTarget) {
            editor.commands.focus("end");
          }
        }}
      >
        {isDragging ? <FileDropOverlay /> : null}
        {showBubbleMenu ? <EditorBubbleMenu editor={editor} /> : null}
        <TableControls editor={editor} rootRef={rootRef} />
        <EditorContent editor={editor} />
      </div>
    );
  },
);
