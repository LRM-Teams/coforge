import { expect, test } from "bun:test";

import { avatarImageHeaders } from "#src/server/http/avatar-image-headers.server";

test("an avatar is served inline, un-sniffed, kept for a versioned year, per viewer", () => {
  expect(avatarImageHeaders("image/png")).toEqual({
    "content-type": "image/png",
    "content-disposition": "inline",
    "x-content-type-options": "nosniff",
    "cache-control": "private, max-age=31536000, immutable",
    vary: "cookie",
  });
});

test("the content type is the caller's, the rest is the rule", () => {
  // The three avatar routes differ only in which variable holds the content type; if one of them ever
  // gains a reason to answer differently, it should stop using this and say so, rather than editing
  // the shared block and changing the other two.
  expect(avatarImageHeaders("image/webp")["content-type"]).toBe("image/webp");
  expect(avatarImageHeaders("image/webp")["content-disposition"]).toBe("inline");
});
