import { expect, test } from "bun:test";
import { workspaceImageSource } from "@/features/agents/profile-panel/agent-workspace-image";

test("a workspace image read becomes a data URL the image renderer can show", () => {
  expect(workspaceImageSource({ contentType: "image/png", contentBase64: "aGk=" })).toBe(
    "data:image/png;base64,aGk=",
  );
  // Any subtype, not an allowlist: the daemon sniffs which formats it will carry back.
  expect(workspaceImageSource({ contentType: "image/avif", contentBase64: "aGk=" })).toBe(
    "data:image/avif;base64,aGk=",
  );
});

test("everything that is not an image stays with the text viewer", () => {
  // A text read: no media type, no bytes.
  expect(workspaceImageSource({ contentType: "", contentBase64: "" })).toBeNull();
  // A media type with no bytes behind it would render as a broken image.
  expect(workspaceImageSource({ contentType: "image/png", contentBase64: "" })).toBeNull();
  // Bytes that do not claim to be an image are never handed to an `<img>`: the pane shows the
  // empty text body instead, which is what a read of a non-image actually carries.
  expect(workspaceImageSource({ contentType: "text/plain", contentBase64: "aGk=" })).toBeNull();
  expect(workspaceImageSource({ contentType: "imagex/png", contentBase64: "aGk=" })).toBeNull();
});
