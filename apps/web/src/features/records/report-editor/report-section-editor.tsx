import { ContentEditor, type ContentEditorProps } from "./content-editor";
import type { UploadResult } from "./types";

export type ReportSectionEditorProps = {
  defaultValue: string;
  onUpdate: (markdown: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  className?: string;
  onUploadFile?: (file: File) => Promise<UploadResult | null>;
};

/**
 * Weekly-report TipTap body. Statically imported from `/records/$recordId`
 * (`ssr: "data-only"`), matching Multica Notes' client-only eager mount.
 */
export function ReportSectionEditor({
  defaultValue,
  onUpdate,
  onBlur,
  placeholder,
  className,
  onUploadFile,
}: ReportSectionEditorProps) {
  const props: ContentEditorProps = {
    defaultValue,
    onUpdate,
    onBlur,
    placeholder,
    className,
    onUploadFile,
    showBubbleMenu: true,
    debounceMs: 150,
  };
  return <ContentEditor {...props} />;
}
