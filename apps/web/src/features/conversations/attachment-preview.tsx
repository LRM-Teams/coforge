import { useEffect, useState } from "react";

import { Button } from "@/components/base/buttons/button";
import { m } from "@/paraglide/messages";
import { MessageBody } from "./message-body";

/** What an attachment can be shown as without leaving the conversation. */
export type AttachmentPreviewKind = "markdown" | "html" | "video" | "audio" | "pdf";

/** Text previews are for a look, and the bytes travel through the authenticated backend route. */
const TEXT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
/** Media has no range requests here (see `MediaPreview`), so the whole file is held in memory;
 * past this the reader is better served by the download. */
const MEDIA_PREVIEW_MAX_BYTES = 50 * 1024 * 1024;

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdown", "mkd"]);
const HTML_EXTENSIONS = new Set(["html", "htm"]);

/**
 * The media types we are willing to hand to a `<video>`/`<audio>` element, and the exact MIME
 * type used for each. The element is fed a Blob we build ourselves with one of these types, so
 * the browser never sniffs an attachment's bytes into something else.
 */
const MEDIA_TYPES = new Map<string, { kind: "video" | "audio"; mimeType: string }>([
  ["mp4", { kind: "video", mimeType: "video/mp4" }],
  ["m4v", { kind: "video", mimeType: "video/mp4" }],
  ["webm", { kind: "video", mimeType: "video/webm" }],
  ["ogv", { kind: "video", mimeType: "video/ogg" }],
  ["mp3", { kind: "audio", mimeType: "audio/mpeg" }],
  ["m4a", { kind: "audio", mimeType: "audio/mp4" }],
  ["wav", { kind: "audio", mimeType: "audio/wav" }],
  ["oga", { kind: "audio", mimeType: "audio/ogg" }],
  ["ogg", { kind: "audio", mimeType: "audio/ogg" }],
]);

function extensionOf(fileName: string): string {
  return fileName.includes(".") ? fileName.split(".").pop()!.toLowerCase() : "";
}

/**
 * Which preview one attachment supports, or `null` for the rest (which stay download-only).
 *
 * The file name decides first: an upload's stored content type is whatever the sender's browser
 * guessed, and a `.md` file routinely arrives as `text/plain` or `application/octet-stream`.
 */
export function attachmentPreviewKind(
  fileName: string,
  contentType: string,
  /** The signed delivery URL, when the server supplied one. A PDF is previewable only with it:
   * the browser's viewer needs a real URL with a real content type, and we only ever give it one
   * on the delivery origin (see `isDeliveryInlinePreview` on the server). Without it — a
   * deployment with no file delivery configured — a PDF stays a download. */
  previewUrl?: string,
): AttachmentPreviewKind | null {
  const extension = extensionOf(fileName);
  if ((extension === "pdf" || contentType === "application/pdf") && previewUrl) return "pdf";
  if (MARKDOWN_EXTENSIONS.has(extension)) return "markdown";
  if (HTML_EXTENSIONS.has(extension)) return "html";
  const media = MEDIA_TYPES.get(extension);
  if (media) return media.kind;
  if (contentType === "text/markdown") return "markdown";
  if (contentType === "text/html") return "html";
  return null;
}

/** The MIME type a previewable media attachment is played as, from our own allowlist. */
function mediaMimeType(fileName: string): string | null {
  return MEDIA_TYPES.get(extensionOf(fileName))?.mimeType ?? null;
}

/**
 * The CSP prepended to a previewed HTML document. `sandbox` already blocks scripts, so this is
 * about the rest of the document's reach: no network requests at all, and inline styles only, so
 * opening a preview cannot quietly call out to a third party with the reader's IP and referrer.
 * A file carrying its own CSP cannot loosen this one — the strictest policy of the two applies.
 */
const PREVIEW_CSP =
  "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:\">";

type FetchState<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "error"; tooLarge: boolean };

/** Fetches one attachment through the authenticated route, bounded by `maxBytes`. */
function useAttachmentBlob(href: string, maxBytes: number): FetchState<Blob> {
  const [state, setState] = useState<FetchState<Blob>>({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    (async () => {
      try {
        const response = await fetch(href, { signal: controller.signal });
        if (!response.ok) throw new Error(`attachment preview failed (${response.status})`);
        const blob = await response.blob();
        if (blob.size > maxBytes) {
          setState({ status: "error", tooLarge: true });
          return;
        }
        setState({ status: "ready", value: blob });
      } catch (error) {
        if (controller.signal.aborted) return;
        void error;
        setState({ status: "error", tooLarge: false });
      }
    })();
    return () => controller.abort();
  }, [href, maxBytes]);
  return state;
}

function PreviewStatus({
  state,
  href,
}: {
  state: { status: "loading" } | { status: "error"; tooLarge: boolean };
  href: string;
}) {
  if (state.status === "loading")
    return (
      <p className="p-4 text-sm text-tertiary sm:p-6">
        {m.conversation_attachment_preview_loading()}
      </p>
    );
  return (
    <div className="flex flex-col items-start gap-3 p-4 sm:p-6">
      <p className="text-sm text-tertiary">
        {state.tooLarge
          ? m.conversation_attachment_preview_too_large()
          : m.conversation_attachment_preview_failed()}
      </p>
      <Button size="sm" color="secondary" href={`${href}?download`}>
        {m.conversation_attachment_download()}
      </Button>
    </div>
  );
}

/**
 * A preview of one attachment, fetched by the browser from the authenticated attachment route.
 *
 * Nothing about the server's delivery changes: the route keeps serving every non-image attachment
 * as an opaque `application/octet-stream` download, so a stored HTML file still can never be
 * loaded as a document in this origin. The bytes are read here instead, and rendered per kind:
 *
 * - `markdown` goes through the same sanitized Markdown renderer a message body uses, so a `.md`
 *   attachment reads exactly like Markdown written in the conversation.
 * - `html` goes into an iframe with an empty `sandbox`, which is a unique opaque origin with
 *   scripts, forms, popups and same-origin access all denied. The document renders, but it cannot
 *   run code, read this page, or reach our cookies.
 * - `video`/`audio` play from a Blob built with a MIME type from our own allowlist, so the
 *   browser decodes media and never sniffs the bytes into markup.
 */
export function AttachmentPreview({
  fileName,
  kind,
  href,
  previewUrl,
}: {
  fileName: string;
  kind: AttachmentPreviewKind;
  /** The authenticated attachment URL; also the download target offered on failure. */
  href: string;
  /** The signed delivery URL; required for `pdf`, unused by the other kinds. */
  previewUrl?: string;
}) {
  if (kind === "pdf")
    return previewUrl ? (
      <PdfPreview fileName={fileName} previewUrl={previewUrl} />
    ) : (
      <PreviewStatus state={{ status: "error", tooLarge: false }} href={href} />
    );
  if (kind === "video" || kind === "audio")
    return <MediaPreview fileName={fileName} kind={kind} href={href} />;
  return <TextPreview fileName={fileName} kind={kind} href={href} />;
}

/**
 * A PDF in the browser's own viewer, loaded from the signed delivery URL.
 *
 * Deliberately **not** sandboxed, and deliberately **not** from our origin. An empty `sandbox`
 * blocks the built-in viewer outright (verified in Chromium: the frame renders the broken-document
 * placeholder instead of the PDF), so isolation has to come from somewhere else — and it does: the
 * signed URL is on the delivery origin, which holds none of our cookies, so a document the sender
 * controls is loaded outside our session's origin. `referrerpolicy` keeps the signed URL out of
 * outbound referrers.
 */
function PdfPreview({ fileName, previewUrl }: { fileName: string; previewUrl: string }) {
  return (
    <iframe
      aria-label={fileName}
      src={previewUrl}
      referrerPolicy="no-referrer"
      className="min-h-0 w-full flex-1 border-0 bg-secondary"
    />
  );
}

function TextPreview({
  fileName,
  kind,
  href,
}: {
  fileName: string;
  kind: "markdown" | "html";
  href: string;
}) {
  const blob = useAttachmentBlob(href, TEXT_PREVIEW_MAX_BYTES);
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (blob.status !== "ready") {
      setText(null);
      return;
    }
    let active = true;
    void blob.value.text().then((value) => {
      if (active) setText(value);
    });
    return () => {
      active = false;
    };
  }, [blob]);

  if (blob.status !== "ready") return <PreviewStatus state={blob} href={href} />;
  if (text === null)
    return (
      <p className="p-4 text-sm text-tertiary sm:p-6">
        {m.conversation_attachment_preview_loading()}
      </p>
    );

  if (kind === "markdown")
    return (
      <div className="min-h-0 flex-1 overflow-auto px-4 py-4 text-md leading-6 text-primary sm:px-6 sm:py-5">
        <MessageBody body={text} />
      </div>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="px-4 pt-3 pb-2 text-xs text-tertiary sm:px-6 sm:pt-4">
        {m.conversation_attachment_preview_html_note()}
      </p>
      <iframe
        // `aria-label` rather than `title`: the shared lint rule reserves `title` for the Tooltip
        // component, and an accessible name for a frame can come from either.
        aria-label={fileName}
        // Empty sandbox: an opaque origin with scripts, forms, popups and same-origin access all
        // denied. Do not add `allow-scripts` — an attachment is untrusted content.
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={`${PREVIEW_CSP}${text}`}
        className="min-h-0 w-full flex-1 border-0 bg-white"
      />
    </div>
  );
}

/**
 * Plays one media attachment from a Blob URL.
 *
 * The whole file is fetched before playback starts (bounded by `MEDIA_PREVIEW_MAX_BYTES`): the
 * attachment route serves an opaque download rather than a range-request media response, so there
 * is nothing to stream from yet. Real streaming would mean serving media inline with its own
 * content type — a change to what this origin is willing to render, which is a separate decision.
 */
function MediaPreview({
  fileName,
  kind,
  href,
}: {
  fileName: string;
  kind: "video" | "audio";
  href: string;
}) {
  const blob = useAttachmentBlob(href, MEDIA_PREVIEW_MAX_BYTES);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const mimeType = mediaMimeType(fileName);
    if (blob.status !== "ready" || !mimeType) {
      setUrl(null);
      return;
    }
    // Retyped from our allowlist rather than trusting the stored content type.
    const objectUrl = URL.createObjectURL(new Blob([blob.value], { type: mimeType }));
    setUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [blob, fileName]);

  if (blob.status !== "ready") return <PreviewStatus state={blob} href={href} />;
  if (!url)
    return (
      <p className="p-4 text-sm text-tertiary sm:p-6">
        {m.conversation_attachment_preview_loading()}
      </p>
    );

  if (kind === "audio")
    return (
      <div className="p-4 sm:p-6">
        <audio src={url} controls className="w-full" aria-label={fileName} />
      </div>
    );
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-black/90 p-4">
      <video src={url} controls className="max-h-full max-w-full" aria-label={fileName} />
    </div>
  );
}
