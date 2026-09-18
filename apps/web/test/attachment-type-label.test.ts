import { describe, expect, test } from "bun:test";

import { attachmentTypeLabel } from "../src/features/conversations/message-row";

describe("the kind shown before an attachment's size", () => {
  test("a real extension names the file", () => {
    expect(attachmentTypeLabel("report.pdf", "application/pdf")).toBe("PDF");
    expect(attachmentTypeLabel("notes.md", "text/plain")).toBe("MD");
    expect(attachmentTypeLabel("archive.tar.gz", "application/gzip")).toBe("GZ");
  });

  test("a name with no usable extension falls back to the media type", () => {
    // The review finding: these used to show a bare size, because the label came only from the
    // file name and `LICENSE.toUpperCase()` equals the name itself.
    expect(attachmentTypeLabel("LICENSE", "text/plain")).toBe("PLAIN");
    expect(attachmentTypeLabel("Dockerfile", "text/x-dockerfile")).toBe("DOCKERFILE");
    expect(attachmentTypeLabel(".env", "text/plain")).toBe("PLAIN");
    expect(attachmentTypeLabel("sheet", "application/vnd.ms-excel")).toBe("MS-EXCEL");
  });

  test("an unknown media type names nothing rather than guessing", () => {
    // `application/octet-stream` is what a browser sends when it has no idea; repeating it would
    // tell a reader nothing, so only the size shows.
    expect(attachmentTypeLabel("LICENSE", "application/octet-stream")).toBeUndefined();
    expect(attachmentTypeLabel("blob", "")).toBeUndefined();
  });

  test("a dotted phrase in a name is not mistaken for an extension", () => {
    expect(attachmentTypeLabel("notes.final version", "text/plain")).toBe("PLAIN");
  });

  test("a long media type stays short enough for one line", () => {
    expect(
      attachmentTypeLabel(
        "deck",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ),
    ).toBe("OPENXMLFORMA");
  });
});
