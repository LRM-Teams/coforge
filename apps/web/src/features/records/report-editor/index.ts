/**
 * Weekly-report TipTap editor (adapted from Multica Notes ContentEditor).
 *
 * Enabled features:
 * - Markdown persistence via @tiptap/markdown
 * - Headings (H1–H5), selection color / font size, lists, task lists, quotes, highlight, links
 * - Inline / block KaTeX formulas ($ / $$)
 * - Tables with column resize controls
 * - Images + file cards (paste/drop upload)
 * - Code blocks with lowlight + Mermaid preview
 * - Slash commands: /code /table /formula
 * - Selection bubble menu
 *
 * Stubbed / omitted vs Multica Notes:
 * - @mentions, #issue/#channel refs, run refs
 * - Empty-line AI / selection AI rewrite
 * - Durable CDN attachment download signing (uploads use host onUploadFile)
 */

export { ContentEditor, type ContentEditorProps, type ContentEditorRef } from "./content-editor";
export { ReportSectionEditor, type ReportSectionEditorProps } from "./report-section-editor";
export type { UploadResult } from "./types";
