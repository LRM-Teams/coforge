import { expect, test } from "bun:test";

import { privateImageHeaders } from "#src/server/http/image-headers.server";

test("a private image is served inline, un-sniffed, kept for a versioned year, per viewer", () => {
  expect(privateImageHeaders("image/png")).toEqual({
    "content-type": "image/png",
    "content-disposition": "inline",
    "x-content-type-options": "nosniff",
    "cache-control": "private, max-age=31536000, immutable",
    vary: "cookie",
  });
});

test("the content type is the caller's, the rest is the rule", () => {
  // The five image routes differ only in which variable holds the content type, and a project icon
  // gained the year's caching this way; if one of them ever needs to answer differently, it should
  // stop using this and say so rather than editing the shared block and changing the others.
  expect(privateImageHeaders("image/webp")["content-type"]).toBe("image/webp");
  expect(privateImageHeaders("image/webp")["content-disposition"]).toBe("inline");
});
