import { describe, expect, test } from "bun:test";

import {
  attachmentPreviewKind,
  isFrameableDocumentUrl,
} from "../src/features/conversations/attachment-preview-kind";

const APP_ORIGIN = "https://app.coforge.cn";
const DELIVERY_ORIGIN = "https://files.coforge.cn";

describe("a PDF is previewable only from a different origin", () => {
  // A PDF renders in the browser's own viewer, which an empty `sandbox` blocks outright, so the
  // origin boundary is the only isolation left: the document must load somewhere that holds none
  // of this application's cookies. Every way of failing that test must fall back to the download.
  test("a signed delivery URL on another origin is previewable", () => {
    expect(
      attachmentPreviewKind(
        "spec.pdf",
        "application/pdf",
        `${DELIVERY_ORIGIN}/o/k?sig=1`,
        APP_ORIGIN,
      ),
    ).toBe("pdf");
  });

  test("a URL on the application's own origin is refused", () => {
    expect(
      attachmentPreviewKind("spec.pdf", "application/pdf", `${APP_ORIGIN}/o/k?sig=1`, APP_ORIGIN),
    ).toBeNull();
  });

  test("a relative or malformed URL is refused", () => {
    expect(
      attachmentPreviewKind("spec.pdf", "application/pdf", "/api/attachments/abc", APP_ORIGIN),
    ).toBeNull();
    expect(
      attachmentPreviewKind("spec.pdf", "application/pdf", "not a url", APP_ORIGIN),
    ).toBeNull();
    expect(
      attachmentPreviewKind("spec.pdf", "application/pdf", "javascript:alert(1)", APP_ORIGIN),
    ).toBeNull();
  });

  test("no delivery URL at all is refused", () => {
    expect(attachmentPreviewKind("spec.pdf", "application/pdf", undefined, APP_ORIGIN)).toBeNull();
    expect(attachmentPreviewKind("spec.pdf", "application/pdf", "", APP_ORIGIN)).toBeNull();
  });

  test("the content type alone is enough to require the same check", () => {
    expect(attachmentPreviewKind("spec.bin", "application/pdf", undefined, APP_ORIGIN)).toBeNull();
    expect(
      attachmentPreviewKind("spec.bin", "application/pdf", `${DELIVERY_ORIGIN}/o/k`, APP_ORIGIN),
    ).toBe("pdf");
  });

  test("during server rendering the server's own refusal is what protects the frame", () => {
    // No page origin exists to compare against; the server has already refused to sign a delivery
    // URL on its own origin, and the browser repeats this check on hydration.
    expect(isFrameableDocumentUrl(`${DELIVERY_ORIGIN}/o/k`, undefined)).toBe(true);
    expect(isFrameableDocumentUrl("/api/attachments/abc", undefined)).toBe(false);
    expect(isFrameableDocumentUrl(undefined, undefined)).toBe(false);
  });
});

describe("the other kinds are decided by name, then by content type", () => {
  test("Markdown and HTML need no delivery URL", () => {
    expect(attachmentPreviewKind("notes.md", "text/plain", undefined, APP_ORIGIN)).toBe("markdown");
    expect(
      attachmentPreviewKind("page.htm", "application/octet-stream", undefined, APP_ORIGIN),
    ).toBe("html");
    expect(attachmentPreviewKind("notes", "text/markdown", undefined, APP_ORIGIN)).toBe("markdown");
  });

  test("allowlisted media is previewable, other files are not", () => {
    expect(attachmentPreviewKind("clip.mp4", "video/mp4", undefined, APP_ORIGIN)).toBe("video");
    expect(attachmentPreviewKind("voice.wav", "audio/wav", undefined, APP_ORIGIN)).toBe("audio");
    expect(
      attachmentPreviewKind("bundle.zip", "application/zip", undefined, APP_ORIGIN),
    ).toBeNull();
    expect(attachmentPreviewKind("logo.svg", "image/svg+xml", undefined, APP_ORIGIN)).toBeNull();
  });
});
