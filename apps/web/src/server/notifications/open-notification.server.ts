import { RFC_UUID_SOURCE } from "@lrm/coforge-sdk/internal";
import { serializeWorkspaceCookie } from "#src/server/workspaces/selection.server";
import { splitWorkspacePath } from "#src/features/workspaces/workspace-url";

/** A conversation under `/w/<slug>` (`/channel/<id>` or `/dm/<id>`), optionally anchored at a
 * message. */
const MESSAGE_TARGET = new RegExp(
  `^/(?:channel|dm)/${RFC_UUID_SOURCE}(?:\\?view=chat#message-${RFC_UUID_SOURCE})?$`,
  "i",
);

export async function notificationOpenResponse(input: {
  request: Request;
  userId: string;
  canAccessWorkspace: (userId: string, slug: string) => Promise<boolean>;
}): Promise<Response> {
  const url = new URL(input.request.url);
  const workspace = url.searchParams.get("workspace") ?? "";
  const target = url.searchParams.get("target") ?? "";
  const place = splitWorkspacePath(target);
  if (!workspace || place?.slug !== workspace || !MESSAGE_TARGET.test(place.rest))
    return redirect("/");
  if (!(await input.canAccessWorkspace(input.userId, workspace))) return redirect("/");
  const headers = new Headers({
    location: target,
    "cache-control": "no-store",
    "set-cookie": serializeWorkspaceCookie(workspace, url.protocol === "https:"),
  });
  return new Response(null, { status: 302, headers });
}

function redirect(location: string) {
  return new Response(null, {
    status: 302,
    headers: { location, "cache-control": "no-store" },
  });
}
