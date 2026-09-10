"use client";

/**
 * Simplified Attachment renderer for the report editor.
 * Renders images and file cards without Multica preview/download galleries.
 */

import { Trash01 as Trash2 } from "@untitledui/icons";
import { cn } from "@/lib/utils";
import { isAllowedFileCardHref } from "./utils/file-cards";

export type AttachmentInput = {
  kind: "url";
  url: string;
  filename: string;
  contentType?: string;
  uploading?: boolean;
  width?: number;
  height?: number;
  forceKind?: "image" | "file";
};

function isImageUrl(url: string, filename: string, forceKind?: "image" | "file"): boolean {
  if (forceKind === "image") return true;
  if (forceKind === "file") return false;
  return /\.(png|jpe?g|gif|webp|svg|ico|bmp|tiff?)$/i.test(filename || url);
}

export function Attachment({
  attachment,
  editable = false,
  selected = false,
  onDelete,
}: {
  attachment: AttachmentInput;
  editable?: boolean;
  selected?: boolean;
  onDelete?: () => void;
}) {
  const { url, filename, uploading, width, height, forceKind } = attachment;
  const asImage = isImageUrl(url, filename, forceKind);

  if (uploading) {
    return (
      <div
        className={cn(
          "flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground",
          asImage && "image-node",
        )}
        data-uploading=""
      >
        Uploading…
      </div>
    );
  }

  if (asImage) {
    return (
      <div className={cn("image-node group relative inline-block", selected && "ring-2 ring-ring")}>
        <figure className="image-figure m-0">
          {/* eslint-disable-next-line @next/next/no-img-element -- TipTap inline image */}
          <img
            src={url}
            alt={filename || ""}
            width={width}
            height={height}
            className="max-w-full rounded-md"
            draggable={false}
          />
        </figure>
        {editable && onDelete ? (
          <button
            type="button"
            className="absolute top-2 right-2 rounded-md bg-background/90 p-1 opacity-0 shadow-sm transition-opacity group-hover:opacity-100"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onDelete();
            }}
            aria-label="Remove image"
          >
            <Trash2 className="size-3.5" />
          </button>
        ) : null}
      </div>
    );
  }

  const safeHref = isAllowedFileCardHref(url) ? url : undefined;

  return (
    <div
      className={cn(
        "file-card group flex items-center gap-3 rounded-md border border-border bg-muted/30 px-3 py-2",
        selected && "ring-2 ring-ring",
      )}
    >
      <div className="min-w-0 flex-1">
        {safeHref ? (
          <a
            href={safeHref}
            target="_blank"
            rel="noopener noreferrer"
            className="truncate text-sm font-medium text-foreground underline-offset-2 hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {filename || "file"}
          </a>
        ) : (
          <span className="truncate text-sm font-medium">{filename || "file"}</span>
        )}
      </div>
      {editable && onDelete ? (
        <button
          type="button"
          className="rounded-md p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-muted"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onDelete();
          }}
          aria-label="Remove file"
        >
          <Trash2 className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}
