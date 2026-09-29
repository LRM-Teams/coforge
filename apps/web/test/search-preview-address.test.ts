import { expect, test } from "bun:test";

import {
  messagePreviewTarget,
  searchPreviewOpenParam,
  searchPreviewTarget,
} from "#src/features/search/search-preview-context";
import { searchPageSearchSchema } from "#src/features/search/search.schemas";

const id = "01991890-89ec-7000-8000-000000000001";
const msg = "01991890-89ec-7000-8000-000000000002";

test("a previewed channel or direct conversation survives the search address", () => {
  for (const kind of ["channel", "dm"] as const) {
    const open = searchPreviewOpenParam({ kind, id });
    const address = searchPageSearchSchema.parse({ q: "export", open, msg });
    expect(searchPreviewTarget(address.open, address.msg)).toEqual({ kind, id, messageId: msg });
  }
  // Anything else in `open` previews nothing.
  expect(searchPageSearchSchema.parse({ open: `agent:${id}` }).open).toBeUndefined();
});

test("a message in any direct conversation previews that conversation", () => {
  const withAgent = { id, channelName: null, directKey: "agent:a|user:u" };
  const betweenMembers = { id, channelName: null, directKey: "user:u|user:v" };
  for (const conversation of [withAgent, betweenMembers])
    expect(messagePreviewTarget(conversation, { id: msg })).toEqual({
      kind: "dm",
      id,
      messageId: msg,
    });
});
