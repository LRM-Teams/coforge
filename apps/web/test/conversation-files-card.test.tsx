import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { FileRow } from "@/features/conversations/conversation-files";
import type { ConversationFile } from "@/features/conversations/conversation-files.functions";
import { m } from "@/paraglide/messages";

const file = (overrides: Partial<ConversationFile> = {}): ConversationFile => ({
  id: "file-1",
  // A Markdown file previews without needing an off-origin signed URL (a PDF does, so it would be
  // download-only during server rendering).
  fileName: "notes.md",
  contentType: "text/markdown",
  sizeBytes: 2_048,
  createdAt: "2026-09-20T10:00:00.000Z",
  sender: "@ada",
  inlineImage: false,
  previewUrl: "https://cdn.example/notes.md?sig=1",
  messageId: "message-1",
  ...overrides,
});

const render = (overrides: Partial<ConversationFile> = {}) =>
  renderToStaticMarkup(<FileRow file={file(overrides)} timeZone={null} />);

/** The card's own click target: the one button that carries the preview label. */
function triggerButton(markup: string, label: string): string {
  const start = markup.indexOf(`aria-label="${label}"`);
  expect(start).toBeGreaterThan(-1);
  const openTag = markup.lastIndexOf("<button", start);
  const closeTag = markup.indexOf("</button>", start);
  return markup.slice(openTag, closeTag);
}

test("clicking anywhere on a previewable card opens the preview, not just the name or thumbnail", () => {
  const markup = render();
  const trigger = triggerButton(
    markup,
    m.conversation_attachment_preview_open({ name: "notes.md" }),
  );

  // The whole card body — file name *and* its metadata — sits inside the trigger.
  expect(trigger).toContain("notes.md");
  expect(trigger).toContain("2 KB");
});

test("an image card is one trigger covering the thumbnail and the name", () => {
  const markup = render({
    fileName: "photo.png",
    contentType: "image/png",
    inlineImage: true,
    previewUrl: "https://cdn.example/photo.png?sig=1",
  });
  const trigger = triggerButton(markup, "photo.png");

  expect(trigger).toContain("<img");
  expect(trigger).toContain("photo.png");
});

test("the actions stay outside the card's trigger, so download never opens a preview", () => {
  const markup = render();
  const trigger = triggerButton(
    markup,
    m.conversation_attachment_preview_open({ name: "notes.md" }),
  );

  expect(trigger).not.toContain("?download");
  expect(trigger).not.toContain(m.files_locate_message());
  expect(markup).toContain("?download");
});

test("a file with nothing to preview has no preview trigger at all", () => {
  const markup = render({
    fileName: "archive.zip",
    contentType: "application/zip",
    previewUrl: undefined,
  });

  expect(markup).toContain("archive.zip");
  expect(markup).not.toContain(m.conversation_attachment_preview_open({ name: "archive.zip" }));
  expect(markup).toContain("?download");
});
