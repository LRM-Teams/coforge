import { ContentEditor, type ContentEditorProps } from "./content-editor";
import type { UploadResult } from "./types";

export type ReportSectionEditorProps = {
  defaultValue: string;
  onUpdate: (markdown: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  className?: string;
  editable?: boolean;
  onUploadFile?: (file: File) => Promise<UploadResult | null>;
};

/**
 * Weekly-report TipTap body. Statically imported from `/records/$recordId`
 * (`ssr: "data-only"`), matching a client-only eager mount.
 */
export function ReportSectionEditor({
  defaultValue,
  onUpdate,
  onBlur,
  placeholder,
  className,
  editable = true,
  onUploadFile,
}: ReportSectionEditorProps) {
  const props: ContentEditorProps = {
    defaultValue,
    onUpdate,
    onBlur,
    placeholder,
    className,
    onUploadFile,
    editable,
    showBubbleMenu: editable,
    debounceMs: 150,
  };
  return <ContentEditor {...props} />;
}
